# Zero-contact income: AI training and evaluation work

No clients, no pitching, no calls, no marketing. You do tasks, you get paid on
a schedule. For someone who does not want to sell, this is the cleanest money
that exists.


---

## Start here: Lithuanian-language work

**No degree, no coding, no interview.** Native fluency in Lithuanian *is* the
qualification, and it is genuinely scarce — Lithuanian is a low-resource
language for AI companies, so they actively recruit native speakers.

Roles advertised for exactly this:

| Company | Role | Rate |
| --- | --- | --- |
| Alignerr | AI Training for Lithuanian Writers | mid |
| RWS TrainAI | AI Data Specialist – Lithuanian | ~$9/hr |
| Invisible Technologies | Lithuanian Language Specialist | $8–65/hr |
| OpenTrain AI | job board, filter by language | varies |

**Put this in perspective.** $9/hr is about €8.30 — already above the
Lithuanian minimum of €7.05/hr. At 20 hours a week that is roughly €715/month;
full time it clears minimum wage outright.

### What the work is

- Writing natural Lithuanian responses to prompts, so the model learns good Lithuanian
- Reading AI-written Lithuanian and marking what sounds wrong, stilted or machine-translated
- Comparing two Lithuanian answers and saying which is better, and why
- Checking translations between Lithuanian and English

You are not judging code or maths. You are judging **whether the Lithuanian is
any good** — which you know natively and most of the planet does not.

### What actually decides whether you keep the work

Not intelligence. **Rubric compliance.** Every project ships a spec: what counts
as a 3 versus a 4, how long comments must be, what to flag. Work is
quality-scored, and low scores mean quiet removal from the project.

Most people who fail skimmed the instructions and rated on instinct. Read the
spec twice, follow it literally even where you disagree, reference its criteria
in your comments. That alone puts you in the top tier — and it rewards care
rather than credentials.

### Apply tonight

1. **Alignerr** — Lithuanian writer roles
2. **RWS TrainAI** — AI Data Specialist, Lithuanian
3. **Invisible Technologies** — Lithuanian Language Specialist
4. **OpenTrain AI** — job board, check weekly
5. **Prolific** — academic surveys, no expertise needed at all, good filler

Apply to all five. They screen independently, cost nothing but an evening, and
rejection from one says nothing about the others.

---

## Eligibility first — do not waste time here

Lithuania is **excluded** from the best-paying platforms. Check this before
anything else.

| Platform | Lithuania | Rate (reported) | Gate |
| --- | --- | --- | --- |
| DataAnnotation | **No** — US/CA/UK/IE/AU/NZ only | $15–40/hr | Written test |
| Outlier (most projects) | **Mostly no** | $25–60/hr | Written test |
| **Mercor** | Screening-based, not geographic | **$85–110/hr** coding | **AI interview** |
| Alignerr | ~100+ countries | mid | Test / application |
| Prolific | Global | low–mid | Open |
| Toloka, Clickworker, Appen, TELUS | Global | often €3–8/hr | Open |

Verify Mercor's supported-countries payment page before investing effort —
payment support and application eligibility are separate things.

**The bottom tier is a trap.** Toloka and Clickworker at €3–8/hr are below
Lithuanian minimum wage (€7.05/hr). Use them as a floor, never a plan.

---

## Mercor: the one worth preparing for

Highest rate by a wide margin, and access is decided by screening rather than
geography. One gate stands in front of it.

### The format

- Automated AI agent, **no human involved**
- 15–20 minutes, voice (sometimes video), recorded
- 6–8 questions, **each generating follow-ups from your own answers**
- Anchored on your resume and profile
- Hiring process averages ~10 days

It is automated but **not a fixed script**. You cannot memorise your way
through it, because it probes wherever you open a door.

### What it scores

**Specificity · Ownership · Technical depth · Communication compression**

Learn these four words. Every answer should visibly hit them.

### The one thing that matters most

**Your profile is the question bank.** The agent drills into what you claim,
using your own wording. Every resume line is an attack surface.

So: **claim less, but claim only what you can go three layers deep on.**

- One project you can discuss in real detail **beats** six technologies you
  touched once.
- Most people fail by padding the resume and then drowning in follow-ups on
  their own padding.
- Editing your profile down is worth more than any answer rehearsal.

Three layers deep means you can answer:
1. What did it do?
2. How did you build it, and what did you choose *not* to do?
3. What broke, and how did you find out?

If a line on your resume fails layer 3, cut it.

### Answer shape

Not a script — the follow-ups make scripts useless. A shape:

> **Claim** → **Specifics** (numbers, names, constraints) → **Your decision**
> and the tradeoff → **How you knew it worked**

Bad: *"I helped build a website generator, it was mostly working with configs."*

Good: *"I built a generator that turns a JSON config into a static one-page
site. The tricky part was opening hours — periods that cross midnight break
naive comparisons, so I modelled each period as an interval and materialised
it against a date in the location's timezone. I have 40 tests on that logic;
two caught real bugs, including a daylight-saving offset I had wrong."*

Same project. The second hits all four scores.

### For a shy person specifically

The hard part of interviews — a human reading your face, real-time judgement,
silence you feel obliged to fill — **is absent.** It is a machine asking about
your work.

But the failure mode of shyness is real and scored against you: **hedging.**
"I kind of helped with", "it was mostly a team thing", "I'm not really an
expert but". That reads as low ownership and low specificity even when the
work was genuinely yours.

Saying "I built X, it does Y, here is the tradeoff I chose" is not bragging.
It is the literal thing being measured. Practise saying it flatly.

### Mechanics

- Quiet room, wired headset or a decent mic. Audio quality is the one thing
  that silently ruins a good interview.
- Speak slightly slower than feels natural. Compression is scored, rambling is not.
- Silence for two seconds to think is fine. Filling it with "um, so, like" is worse.
- Do it once, properly. It is the primary gate — treat it as one shot.

### On cheating

Guides exist claiming to beat this interview. Skip them. You would clear the
gate and then fail the paid work, because evaluating code **is** the job. The
test is not a formality standing between you and easy money.

---

## An honest note about this repository

The site generator and plugin in this repo were written by an AI assistant on
your instruction. In a technical interview, **do not present that code as
something you personally wrote.** The follow-ups will go three layers deep and
it will collapse — and it would be dishonest.

There is an honest version, and it is genuinely worth something:

> Read `templates/build.py` and `plugin/.../class-lbsh-schedule.php` until you
> actually understand them. Change something. Break something and fix it. Add
> a template yourself.

Then it is truthfully your project — you specified it, you understand it, you
can defend every decision — and you can say so. That is not a workaround; it
is how you turn a delivered artifact into a real skill. The schedule engine in
particular contains a genuinely non-obvious problem (timezone-aware intervals
crossing midnight, with holiday exceptions) that is good interview material
*if* you can explain it from understanding.

---

## Route yourself

**Without a technical background**, ignore the Mercor coding track. It screens
for demonstrable software experience and the interview drills three layers into
whatever you claim. Language work above pays comparably per hour for the hours
you can actually get, and has no interview gate.

**Go: Lithuanian-language work.** It is the section at the top of this file. It
is the fastest route to money that does not depend on credentials you do not
have, and your native fluency is a real, scarce qualification rather than a
consolation prize.

**Prolific alongside it** — academic surveys need no expertise whatsoever.
Small money, but it starts immediately and fills gaps between projects.

**Mercor is still worth an application** if your depth is in any specialist
field — law, medicine, finance, a trade, a language. Credentialed non-coding
experts are reportedly the best-paid category there. Just not the coding track.

---

## Realistic expectations

- Mercor: ~10 days end to end, and most applicants do not clear screening.
  High value, low probability — worth exactly one well-prepared attempt.
- Written-test platforms: lower rate, far higher acceptance, money in 1–2 weeks.
- **Do both.** They cost nothing but an evening, and they fail independently.
