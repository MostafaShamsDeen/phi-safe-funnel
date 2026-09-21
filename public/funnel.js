/**
 * Funnel rendering and the browser half of the deduplication contract.
 *
 * The event id is generated here, once, and used in two places: the pixel event
 * fired in the browser and the server event sent from the API. That shared id is
 * what stops Meta counting one lead twice.
 */

const FIELD_KINDS = {
  state: 'sent',
  zip: 'sent',
  country: 'sent',
  email: 'sent',
  phone: 'sent',
  first_name: 'sent',
  last_name: 'sent',
  condition: 'retained',
  symptoms: 'retained',
  over_18: 'retained',
};

/**
 * Mirrors the normalisers in src/hash.ts so the preview shows the value that is
 * actually hashed, not the value as typed. Showing sha256("Shams El Deen") when
 * the server hashes "shamseldeen" would be a comforting lie.
 */
const NORMALISE = {
  email: (v) => v.trim().toLowerCase(),
  phone: (v) => {
    const d = v.replace(/[^\d]/g, '');
    return d.startsWith('00') ? d.slice(2) : d;
  },
  first_name: (v) => v.trim().toLowerCase().replace(/[^a-z]/g, ''),
  last_name: (v) => v.trim().toLowerCase().replace(/[^a-z]/g, ''),
  state: (v) => v.trim().toLowerCase().replace(/[^a-z]/g, ''),
  zip: (v) => v.trim().toLowerCase().split('-')[0].slice(0, 5),
  country: (v) => v.trim().toLowerCase().slice(0, 2),
};

const STEPS = [
  {
    field: 'state',
    question: 'Which state do you live in?',
    choices: [
      ['CA', 'California'],
      ['NY', 'New York'],
      ['TX', 'Texas'],
      ['FL', 'Florida'],
      ['WA', 'Washington'],
      ['OTHER', 'Somewhere else'],
    ],
  },
  {
    field: 'over_18',
    question: 'Are you 18 or older?',
    choices: [
      ['yes', 'Yes'],
      ['no', 'No'],
    ],
  },
  {
    field: 'condition',
    question: 'What would you like to speak to a clinician about?',
    choices: [
      ['sleep', 'Sleep'],
      ['skin', 'Skin'],
      ['weight', 'Weight management'],
      ['other', 'Something else'],
    ],
  },
  {
    field: 'symptoms',
    question: 'How long has this been going on?',
    choices: [
      ['under_1_month', 'Less than a month'],
      ['1_to_6_months', 'One to six months'],
      ['over_6_months', 'More than six months'],
    ],
    showIf: (a) => a.condition && a.condition !== 'other',
  },
  { field: 'contact', question: 'Where should the clinician reach you?', contact: true },
];

const answers = {};
const eventId = crypto.randomUUID();

const screenEl = document.getElementById('screen');
const progressEl = document.getElementById('progress');
const retainedEl = document.getElementById('retained-list');
const matchableEl = document.getElementById('matchable-list');
const resultEl = document.getElementById('result');
const modeEl = document.getElementById('mode');

modeEl.textContent = `event_id ${eventId.slice(0, 8)}…`;

function visibleSteps() {
  return STEPS.filter((s) => (s.showIf ? s.showIf(answers) : true));
}

function currentStep() {
  return visibleSteps().find((s) => (s.contact ? answers.email === undefined : answers[s.field] === undefined));
}

function renderBoundary() {
  const retained = [];
  const sent = [];
  for (const [field, value] of Object.entries(answers)) {
    const target = FIELD_KINDS[field] === 'sent' ? sent : retained;
    target.push([field, value]);
  }

  const paint = (el, rows, hashed) => {
    el.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'nothing yet';
      el.append(li);
      return;
    }
    for (const [field, value] of rows) {
      const li = document.createElement('li');
      const shown = hashed ? `sha256(${(NORMALISE[field] ?? ((v) => v))(value)})` : value;
      li.innerHTML = `${field} <span class="val">${shown}</span>`;
      el.append(li);
    }
  };

  paint(retainedEl, retained, false);
  paint(matchableEl, sent, true);
}

function render() {
  const step = currentStep();
  const total = visibleSteps().length;
  const done = total - visibleSteps().filter((s) => (s.contact ? answers.email === undefined : answers[s.field] === undefined)).length;
  progressEl.style.width = `${Math.round((done / total) * 100)}%`;
  renderBoundary();

  if (!step) return;
  screenEl.innerHTML = '';

  const h = document.createElement('p');
  h.className = 'question';
  h.textContent = step.question;
  screenEl.append(h);

  if (step.contact) {
    const wrap = document.createElement('div');
    for (const [name, label, type] of [
      ['first_name', 'First name', 'text'],
      ['last_name', 'Last name', 'text'],
      ['email', 'Email', 'email'],
      ['phone', 'Phone (international format)', 'tel'],
      ['zip', 'ZIP', 'text'],
    ]) {
      const field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" />`;
      wrap.append(field);
    }
    const consent = document.createElement('label');
    consent.className = 'consent';
    consent.innerHTML =
      '<input type="checkbox" id="consent_marketing" /> ' +
      '<span>I agree to analytics and marketing cookies. Leave this unticked to see the gate work: ' +
      'the submission is still processed, and nothing reaches the advertising platform.</span>';
    wrap.append(consent);

    const go = document.createElement('button');
    go.className = 'submit';
    go.textContent = 'Submit';
    go.onclick = () => {
      for (const name of ['first_name', 'last_name', 'email', 'phone', 'zip']) {
        const value = document.getElementById(name).value.trim();
        if (value) answers[name] = value;
      }
      answers.country = 'US';
      answers.consent_marketing = document.getElementById('consent_marketing').checked ? 'yes' : 'no';
      if (!answers.email) return;
      submit();
    };
    wrap.append(go);
    screenEl.append(wrap);

    ['first_name', 'last_name', 'email', 'phone', 'zip'].forEach((name) => {
      document.getElementById(name).addEventListener('input', (e) => {
        const v = e.target.value.trim();
        if (v) answers[name] = v;
        else delete answers[name];
        renderBoundary();
      });
    });
    return;
  }

  const choices = document.createElement('div');
  choices.className = 'choices';
  for (const [value, label] of step.choices) {
    const b = document.createElement('button');
    b.className = 'choice';
    b.textContent = label;
    b.onclick = () => {
      answers[step.field] = value;
      render();
    };
    choices.append(b);
  }
  screenEl.append(choices);
}

async function submit() {
  // The browser half of the dedup pair, behind the same gate as the server half.
  // A consent banner that gates the pixel while the server fires anyway is
  // decoration, so both sides check the same answer.
  if (answers.consent_marketing === 'yes') {
    if (typeof window.fbq === 'function') {
      window.fbq('track', 'Lead', {}, { eventID: eventId });
    } else {
      console.log('[pixel] fbq("track", "Lead", {}, { eventID: "%s" })', eventId);
    }
  } else {
    console.log('[pixel] suppressed: no marketing consent');
  }

  screenEl.innerHTML = '<p class="question">Sending…</p>';

  const response = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId, answers, sourceUrl: window.location.href }),
  });
  const data = await response.json();

  screenEl.innerHTML = '';
  const verdict = document.createElement('p');
  verdict.className = 'question';
  verdict.textContent = data.eligibility.eligible
    ? 'Eligible. A clinician will be in touch.'
    : data.eligibility.reason;
  screenEl.append(verdict);

  const again = document.createElement('button');
  again.className = 'submit';
  again.textContent = 'Start again';
  again.onclick = () => window.location.reload();
  screenEl.append(again);

  const suppressed = {
    no_consent: 'No advertising event fired: marketing consent was not given.',
    not_eligible: 'No advertising event fired: the visitor was not eligible.',
  };

  resultEl.hidden = false;
  resultEl.innerHTML = `
    <h3>What the server did</h3>
    <p class="verdict">${data.outbound.send ? 'Lead event built' : suppressed[data.outbound.reason]}</p>
    <p class="dedup">
      ${
        data.outbound.send
          ? `Browser pixel and server event share <code>event_id ${eventId}</code>, which is how Meta collapses them into one conversion.`
          : 'The pixel was suppressed in the browser as well, not just on the server. Check the console.'
      }
      ${data.capi ? `Mode: <code>${data.capi.mode}</code>.` : ''}
    </p>
    ${data.capi ? `<pre>${JSON.stringify(data.capi.payload, null, 2)}</pre>` : ''}
    <p class="dedup">Retained on the server: <code>${data.retainedFields.join(', ') || 'none'}</code></p>
    ${data.unclassified.length ? `<p class="dedup">Unclassified, treated as PHI: <code>${data.unclassified.join(', ')}</code></p>` : ''}
  `;
  progressEl.style.width = '100%';
}

render();
