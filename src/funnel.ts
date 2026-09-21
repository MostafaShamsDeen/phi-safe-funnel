/**
 * The funnel definition: steps, branching and the eligibility decision.
 *
 * Kept as data and pure functions rather than wired into the server, so the
 * branching can be tested without HTTP and so the same definition drives both
 * the client rendering and the server-side revalidation. The client decides
 * which screen to show next; the server decides whether someone is actually
 * eligible, because a client-side gate is a suggestion.
 */

export type StepId = 'state' | 'age' | 'condition' | 'severity' | 'contact';

export interface Choice {
  value: string;
  label: string;
}

export interface Step {
  id: StepId;
  /** Field name written into the answers object. Classified in phi.ts. */
  field: string;
  question: string;
  kind: 'select' | 'radio' | 'contact';
  choices?: Choice[];
  /** Shown only when this predicate passes, which is how branching works. */
  showIf?: (answers: Record<string, string>) => boolean;
}

/** States this imaginary practice is licensed in. */
export const SERVICED_STATES = ['CA', 'NY', 'TX', 'FL', 'WA'];

export const STEPS: Step[] = [
  {
    id: 'state',
    field: 'state',
    question: 'Which state do you live in?',
    kind: 'select',
    choices: [
      { value: 'CA', label: 'California' },
      { value: 'NY', label: 'New York' },
      { value: 'TX', label: 'Texas' },
      { value: 'FL', label: 'Florida' },
      { value: 'WA', label: 'Washington' },
      { value: 'OTHER', label: 'Somewhere else' },
    ],
  },
  {
    id: 'age',
    field: 'over_18',
    question: 'Are you 18 or older?',
    kind: 'radio',
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    id: 'condition',
    field: 'condition',
    question: 'What would you like to speak to a clinician about?',
    kind: 'radio',
    choices: [
      { value: 'sleep', label: 'Sleep' },
      { value: 'skin', label: 'Skin' },
      { value: 'weight', label: 'Weight management' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'severity',
    field: 'symptoms',
    question: 'How long has this been going on?',
    kind: 'radio',
    choices: [
      { value: 'under_1_month', label: 'Less than a month' },
      { value: '1_to_6_months', label: 'One to six months' },
      { value: 'over_6_months', label: 'More than six months' },
    ],
    // Branching: only asked when a specific condition was chosen.
    showIf: (a) => a.condition !== undefined && a.condition !== 'other',
  },
  {
    id: 'contact',
    field: 'contact',
    question: 'Where should the clinician reach you?',
    kind: 'contact',
  },
];

export function nextStep(answers: Record<string, string>): Step | undefined {
  return STEPS.find((step) => {
    const answered = step.kind === 'contact' ? answers.email !== undefined : answers[step.field] !== undefined;
    if (answered) return false;
    return step.showIf ? step.showIf(answers) : true;
  });
}

export interface EligibilityResult {
  eligible: boolean;
  /** Shown to the visitor. Deliberately free of clinical detail. */
  reason?: string;
  /** For internal logging only. Never sent outward. */
  code?: 'out_of_area' | 'under_18' | 'incomplete';
}

export function evaluateEligibility(answers: Record<string, string>): EligibilityResult {
  if (!answers.state || !answers.over_18) {
    return { eligible: false, reason: 'We need a couple more answers.', code: 'incomplete' };
  }
  if (!SERVICED_STATES.includes(answers.state)) {
    return {
      eligible: false,
      reason: 'We are not licensed to provide care in your state yet.',
      code: 'out_of_area',
    };
  }
  if (answers.over_18 !== 'yes') {
    return {
      eligible: false,
      reason: 'This service is available to adults aged 18 and over.',
      code: 'under_18',
    };
  }
  return { eligible: true };
}

/**
 * Which advertising event a completed submission maps to.
 *
 * Always generic. The temptation is to fire "SleepConsultBooked" so the ad
 * platform can optimise per condition, and that single decision is how a
 * compliant stack becomes a non-compliant one.
 */
export function eventNameFor(result: EligibilityResult): 'Lead' | null {
  return result.eligible ? 'Lead' : null;
}
