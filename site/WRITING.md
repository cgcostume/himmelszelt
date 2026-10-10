# Writing the chapters

How sternwarte's chapters are written, distilled from sternzeit, the finished one. Read this before writing or editing
any chapter text, caption, glossary entry or code example. When this file and sternzeit disagree, fix one of them.

## Audience and voice

- Developers who want to use the libraries, curious about the sky but not astronomers or physicists. The text should be
  a joy to read, educational, and nerdy.
- Address the reader as **you** ("your sky", "the place you chose"). **We** is humanity on the ground looking up ("where
  we watch from", "we see the Sun where it was"), never the authors. Never **I**, and nothing personal: no places,
  dates or sightings from the authors' lives.
- Present tense, active voice, plain words. Calm and confident: no hype ("powerful", "blazing fast", "seamless"), no
  hedging ("basically", "just", "simply" in the sense of "easy").
- Explain from the sky to the code: a phenomenon or a question first, then the concept that answers it, then the number
  that pins it down, then the function that computes it. Never the other way round.
- Curious rather than complete. A section explains what a renderer needs and stops; the details live in the cited
  sources and the API reference.

## What makes it nerdy

- **Every number gets an anchor** the reader can picture: "20.5 arcseconds, under a ninetieth of the Sun's disc", "up to
  a degree, two of its own diameters", "within 0.002°, invisible next to a disc half a degree wide". A bare number in
  prose is a missed chance.
- **One surprising, true fact per section**, tied back to the topic, never a detour: Earth turns 366 times a year, the
  Moon is the original three-body problem, no star has ever shone through the Moon.
- **Name the classic mistakes** renderers make and show the reasoning that rules them out (the crescent lit from above,
  the unlit Moon as a hole). This is where the text earns its keep with developers.
- **Invite the reader to try something** in a figure, and say what they will see: "Raise the height to 10 km, and the
  horizon sinks by more than 3°", "Step the moment a day at a time, and sidereal time gains almost a degree".
- **People, briefly.** The sources are people: a closing section ("The people behind the numbers") gives each a
  sentence or two of who they were and ties them to the function their work powers.

## Chapter structure

The layout adds the name's meaning (from the glossary) under the title, the lead (the `summary`), a meta line (last
updated, term hint), a TOC from three sections on, and the references right after the content; the short himmelszelt
note shows only on a withheld chapter's placeholder, as the header and footer say the rest.

The body, in this order:

1. **Opening, without a heading.** A hook from the sky (what a faithful sky needs to know, or a question a reader has
   asked themselves). Then what the library is, in plain words, and where it stands next to existing work. Then what it
   can be used for, ending in links to the worked tasks further down. Then a bridge to the interactive scene, which
   follows with the moment and place controls under it, and one short paragraph on how the figures and controls work.
   Keep the opening to three paragraphs before the scene; anything that is a concept belongs in a section.
2. **Concept sections** building on each other: each uses only what earlier ones explained. A section reads phenomenon,
   concept, number, function, figure or table, an invitation to try it, and a code example where one fits.
3. **A capstone section** that combines the pieces into one thing worth building (sternzeit: "A month of Moons"), with
   its code and its live result, and a short look at what else the same functions could do.
4. **"Precise or approximate?"** wherever both variants exist: what each follows, how far apart they are in visible
   terms, when the precise one is worth it, how to switch.
5. **"The people behind the numbers."**
6. The references, generated.

No separate code examples section, no subsections (`###`), no bold, no "Note:" boxes, and no bullet lists: what could
be a list is a sentence ("The function names carry these steps as prefixes, `mean`, `true`, ...").

## Headings

Sentence case, short. A noun phrase ("The Sun", "Eclipses"), or a phrase with a point of view ("Counting time the
astronomer's way", "Earth, the platform we observe from"). A question only where the section answers exactly that
question ("Precise or approximate?", "Why is the sky blue?"). German terms only where they are the term ("Luftperspektive").

## Lead (`summary`)

One line, under about 90 characters, saying what the library gives a renderer and why it is interesting. Not a feature
list, and never a promise the chapter does not keep yet.

## Paragraphs and sentences

- One idea per paragraph, three to seven sentences. A paragraph that introduces more than two glossary terms is too
  dense: split it.
- Vary sentence length; a short sentence lands the point ("Calendars are a mess.").
- The colon delivers a payoff or an explanation: "None of this is guesswork: Jean Meeus wrote it all down as recipes."
- No em-dash, anywhere. Use a comma, a colon, or two sentences.
- Parentheses only for figure and table references, a one-word label ("(total)"), or a very short aside. Anything
  longer is its own sentence.
- No runts: never a single word alone on a paragraph's last line (`text-wrap: pretty` handles most; reword if not).
- Say each thing once. If a later section needs it again, refer back in half a sentence instead of re-explaining.
- Signposts are links in the sentence ("[the next eclipse](#eclipses)"), not "as shown below" or "see the next section".
- MDX source wrapped at 120 columns.

## Words, spelling and numbers

- **American English** everywhere, code comments included: color, center, gray, catalog, kilometer, meter,
  visualization, labeled, traveled, neighbor. Proper names keep theirs (the Yale Bright Star Catalogue). "towards" is fine.
- **Sun, Moon, Earth** are capitalized as bodies: "the Sun", "the Moon", "Earth" (no article, "Earth's"). Lowercase in
  compounds and phases: sunlight, moonlight, sunrise, earthshine, full moon, new moon, a moon calendar. The plural of
  drawn Moon discs is "Moons".
- **Package names** lowercase and unformatted in prose, even at the start of a sentence: "sternzeit is one more
  implementation". The npm name `@himmelszelt/sternzeit` in code formatting, only where the package itself is meant.
- **API names** in backticks, exactly as called: `sun.direction`, `moon.earthshine`. Use the plain-English concept in
  prose and the function name where the reader would type it.
- **Units**: digits with a narrow no-break space (U+202F) before SI units ("3.8 cm", "10 km"), no space before °
  ("23.4°"). Arcseconds and units of time written out in prose ("20 arcseconds", "8 minutes 20 seconds"); ″ only in
  tables and figures. The first arcsecond in a chapter is `<Term of="Arcsecond">`, whose tooltip scales it to a coin.
- **Approximate values** with "about" or "some" and one or two significant figures in prose; exact values belong in
  the tables.
- **Small counts** in words ("four tasks", "two weeks", "nine tenths"), measurements in digits.
- **Dates** the American way: "August 12, 2026", "January 1, 2000", "4713 BCE". Times on a 24-hour clock with the zone
  said in words ("20:09 local time", "16:18 UTC"). ISO dates only inside code.
- **Directions** are ENU everywhere: x east, y north, z up; azimuths from north through east. Say once per chapter how
  a y-up engine assigns them, `(x, z, -y)`.

## Glossary terms (`<Term>`)

- Every technical term gets a `<Term>` at its first appearance in the chapter's body, and only there. Captions and
  tables may mark it again, as they are read on their own.
- The text still says enough that a reader who never hovers can follow; the tooltip adds the definition, not the point.
- A glossary entry is one to three sentences: what it is as a noun phrase first, then what it looks like or why a
  renderer cares. Same spelling and capitalization rules as the text. One site-wide `glossary.json`; terms shared by
  chapters are defined once.

## Citations (`<Cite>`)

Right after the claim they back, before the punctuation; several in a row separated by spaces. Cite the source of a
number or a model, not the general background. Every id in the frontmatter's `references` must be cited in the text.

## Figures and tables

- Refer to a figure with `<Fig id="..." />` and a table with `<Tab id="..." />`, only in parentheses after what they
  show: "(Figure 2)", never "Figure 2 shows" or a sentence starting with it. Never type a number.
- A figure sits after the paragraph that first needs it; every figure and unfolded table gets `<Controls />` under it.
- **Captions**: what the figure is first, as a noun phrase ("A sun path diagram: ..."), then how to read it (colors,
  dashes, arrows), subfigures as "(a) ... (b) ...", then scale ("Symbols, not to scale", "Magnified, discs and horizon
  true to each other"), credits, and what to do with it last ("Hover to read off any other.", "Click to move the moment
  there."). A figure with a credit line over it says there instead what to do with it, before the credit ("Drag
  to rotate, click the Sun or the Moon to annotate it. Visualized with Zdog."). "The chosen place" and "the chosen moment" for whatever the controls are set to.
- Figures render on demand, never in a continuous loop (the one exception: the corona in the eclipse figure turns
  while it shows and is in view), and are built so the later Tafeln can lift them out (colors
  from CSS tokens, UI switchable off, no reach into the chapter's DOM).
- `<Planned>` boxes for figures not yet built render under `pnpm dev` only; the published text never relies on them.

## Code examples

- Each sits in the section whose concepts it uses, led into by the sentence before it, which says what the code is
  for and ends in a period or a colon. Never "Here is an example".
- Short enough to read in one go, complete enough to copy: real imports from `@himmelszelt/<name>`, nothing hidden.
  The reader's own values stay free variables (`latitude`, `longitude`); functions the reader brings (`drawMoonDisc`)
  are named as such in the lead-in.
- Lines at most 80 columns, so the block fits the text column without scrolling; long import lists wrapped.
- Comments in the same voice as the text, saying why, not what. Put a real result in a comment where it helps
  ("// 2461305.25, the offset applied", "totality on 2028-12-31, from 16:18 UTC"), and check that it is true.
- An example that runs on the page has its live output right below it, led in with a colon ("Run for the chosen day,
  place and clock:").

## Facts

Every number in the text is checked against the library's output or a cited source before it goes in, and again when
the code changes. Dates of events (eclipses, perihelion) are real and verified. Claims about the library ("stays within
0.002°") are measured, not estimated.

## Draft chapters

`draft: true` shows a chapter in full under `pnpm dev` and as a placeholder in the build. While drafting, an opening
line may say the chapter is being written; it goes before publishing.
