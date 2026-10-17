# Writing the chapters

How sternwarte's chapters are written, distilled from sternzeit, the finished one. Read this before writing or editing
any chapter text, caption, glossary entry or code example. When this file and sternzeit disagree, fix one of them.

## Audience and voice

- Written first for two readers: developers who want to use the libraries, and people interested in science who want
  to understand the sky. Neither is an astronomer or a physicist. The text should be a joy to read, educational, and
  nerdy.
- Welcome, not targeted: students from the upper school years on, and readers new to code, who follow the sky and skip
  the code. Every paragraph before a code block says what the code computes, so skipping it loses nothing. Inclusive
  and plain, but neither written for children nor a course: no exercises, no talking down.
- Someone who only wants to know what a library is about learns it from the first two sentences of the opening.
- Address the reader as **you** ("your sky", "the place you chose"). **We** is humanity on the ground looking up ("where
  we watch from", "we see the Sun where it was"), never the authors. Never **I**, and nothing personal: no places,
  dates or sightings from the authors' lives.
- Present tense, active voice, plain words. Calm and confident: no hype ("powerful", "blazing fast", "seamless"), no
  hedging ("basically", "just", "simply" in the sense of "easy").
- Explain from the sky to the code: a phenomenon or a question first, then the concept that answers it, then the number
  that pins it down, then the function that computes it. Never the other way round.
- Curious rather than complete. A section explains what a renderer needs and stops; the details live in the cited
  sources and the API reference.
- Easy on the reader. Most paragraphs should be readable without hovering a single term; one hard idea per section at
  most, and only if a renderer needs it or it is genuinely surprising. A complicated detail that is neither, however
  true and however clever, goes.

## What makes it nerdy

- **Every number gets an anchor** the reader can picture: "20.5 arcseconds, under a ninetieth of the Sun's disc", "up to
  a degree, two of its own diameters", "within 0.002°, invisible next to a disc half a degree wide". A bare number in
  prose is a missed chance.
- **One surprising, true fact per section**, tied back to the topic, never a detour, and simple to state: if it takes a
  paragraph of setup, it is not the fun fact. Earth turns 366 times a year, the
  Moon is the original three-body problem, no star has ever shone through the Moon.
- **Name the classic mistakes** renderers make and show the reasoning that rules them out (the crescent lit from above,
  the unlit Moon as a hole). This is where the text earns its keep with developers.
- **Invite the reader to try something** in a figure, and say what they will see: "Raise the height to 10 km, and the
  horizon sinks by more than 3°", "Step the moment a day at a time, and sidereal time gains almost a degree". The
  captions add one experiment each, a click away (see Figures and tables).
- **People, briefly.** The sources are people: a closing section ("The people behind the numbers") gives every source
  a library function rests on a sentence or two of who they were and ties them to that function. The authors' own
  papers are cited, but their authors not portrayed.

## Chapter structure

The layout adds the name's meaning (from the glossary) under the title, the lead (the `summary`), a meta line (last
updated, term hint), a TOC from three sections on, and the references right after the content; the short himmelszelt
note shows only on a withheld chapter's placeholder, as the header and footer say the rest.

The body, in this order:

1. **Opening, without a heading.** A hook from the sky, a thought or a question, answered at once by what the library
   computes, then where
   it stands next to existing work, and which neighboring chapter covers what it leaves out. Then the developer's facts
   in a sentence each (language, dependencies, where it runs, what a call costs, measured) and what it can be used for,
   ending in links to the worked tasks further down. Then a bridge to the interactive scene, which follows with the
   moment and place controls under it, and one short paragraph on how the figures and controls work. Then a quick
   start: the install line and the few lines a developer came for, and one sentence leading into the sections. Keep
   the opening to three paragraphs before the scene; anything that is a concept belongs in a section.
2. **Concept sections** building on each other: each uses only what earlier ones explained, and the chapter gets
   harder only as slowly as it has to. Each opens with what anyone can see in the sky, never with the computation.
   Where a section turns to code a reader after the sky can skip, one sentence says so and links to the next section;
   at most once a chapter, never as a box or a label on paragraphs. A section reads phenomenon, concept, number, function, figure or table, an
   invitation to try it, and a code example where one fits. Within a section, too, the parts build up: what a reader
   sees first, the machinery after it, and the call a renderer actually uses closes it.
3. **A capstone section** that combines the pieces into one thing worth building (sternzeit: "A month of Moons"), with
   its code and its live result, and a short look at what else the same functions could do.
4. **"Precise and approximate"** wherever both variants exist: what each follows, how far apart they are in visible
   terms, when the precise one is worth it, how to switch.
5. **"The people behind the numbers."**
6. The references, generated.

No separate code examples section, no subsections (`###`), no bold, no "Note:" boxes, and no bullet lists: what could
be a list is a sentence ("The function names carry these steps as prefixes, `mean`, `true`, ...").

## Headings

Sentence case, short. A noun phrase ("The Sun", "Eclipses"), or a phrase with a point of view ("Counting time the
astronomer's way", "Earth, the platform we observe from"). Never a question: "Why the sky is blue", not
"Why is the sky blue?". German terms only where they are the term ("Luftperspektive").

## Lead (`summary`)

One line, under about 90 characters, saying what the library gives a renderer and why it is interesting. Not a feature
list, and never a promise the chapter does not keep yet.

## Paragraphs and sentences

- One idea per paragraph, three to seven sentences.
- Vary sentence length; a short sentence lands the point ("Calendars are a mess.").
- The colon delivers a payoff or an explanation: "None of this is guesswork: Jean Meeus wrote it all down as recipes."
- No em-dash, anywhere. Use a comma, a colon, or two sentences.
- Parentheses only for figure and table references, a one-word label ("(total)"), or a very short aside. Anything
  longer is its own sentence.
- No runts: never a single word alone on a paragraph's last line (`text-wrap: pretty` handles most; reword if not).
- No personification: things do only what they can. Thresholds, numbers and functions do not draw, tell or want; say who
  or what acts ("computed for every day, the crossings can be used to visualize the year", not "the thresholds draw").
- Say each thing once. If a later section needs it again, refer back in half a sentence instead of re-explaining.
- Signposts are links in the sentence ("[the next eclipse](#eclipses)"), not "as shown below" or "see the next section".
- MDX source wrapped at 120 columns.

## Words, spelling and numbers

- **American English** everywhere, code comments included: color, center, gray, catalog, kilometer, meter,
  visualization, labeled, traveled, neighbor. Proper names keep theirs (the Yale Bright Star Catalogue). "towards" is
  fine.
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
- **Symbols** (φ, ε, θ, α, δ, l, β, π, A, h) only for what the figures and code use, each introduced once, as a
  one-word aside where its concept first appears ("the obliquity of the ecliptic, ε."), and words after that. No
  formulas in prose, no symbol a reader meets nowhere else.
- **Wavelength, not color**, for what light is made of: scattering "depends on the wavelength", not "cares about the
  color". Color is what the eye or a screen makes of a spectrum: the sky's color, a color outside the gamut.
- **Directions** are ENU everywhere: x east, y north, z up; azimuths from north through east. Say once per chapter how
  a y-up engine assigns them, `(x, z, -y)`.

## Glossary terms (`<Term>`)

- Every technical term gets a `<Term>` at its first appearance in the chapter's body, the opening included, and only
  there. Captions and tables may mark it again, as they are read on their own. A term first met in a caption still gets
  its `<Term>` where the text first uses it.
- The text still says enough that a reader who never hovers can follow; the tooltip adds the definition, not the point.
- A glossary entry is one to three sentences: what it is as a noun phrase first, then what it looks like or why a
  renderer cares. Same spelling, capitalization, number and date rules as the text: "about", not "~"; no contractions;
  no long parentheses. One site-wide `glossary.json`; terms shared by chapters are defined once.
- A tooltip is read on its own, anywhere: no "below" or "above", no pointers into source files ("see `eclipse.ts`"),
  and API names only as the library exports them. Numbers in an entry are checked like those in the text, and an entry
  matches what the library computes (an eclipse phase defined as the code defines it, not as it was once planned).
- Table rows without a glossary entry get their tooltip from the table's own descriptions (`DESCRIPTIONS` in
  `tables.ts`), held to the same rules. Every row has one or the other.

## Citations (`<Cite>`)

Right after the claim they back, before the punctuation; several in a row separated by spaces. Cite the source of a
number or a model, not the general background. Every id in the frontmatter's `references` must be cited in the text.

What needs a citation: every number and claim the library does not compute itself (a rate such as the Moon's 3.8 cm a
year, a constant from a fact sheet, a date in history, a person's life), and every data set a figure draws (ΔT from the
IERS). What the library computes is backed by the tables and needs none; a number derived from both, such as the 600
million years until the last total eclipse, must be one a reader could redo from them. Links in the text (SunCalc,
astronomia) and credit lines in captions count as references too. A claim that cannot be sourced is rephrased until it
can, or goes.

## Figures and tables

- Every figure and every table is referenced in the text, at least once. Refer to a figure with `<Fig id="..." />` and
  a table with `<Tab id="..." />`, only in parentheses after what they show: "(Figure 2)", never "Figure 2 shows" or a
  sentence starting with it. Never type a number.
- A figure or table sits right after the paragraph holding its first reference, never before it; a later reference is
  fine anywhere. A paragraph that needs a figure but would not otherwise mention it gets the reference anyway.
- Every figure that follows the moment and the place, and every table, gets `<Controls />` under it; a static diagram
  (the coordinate pipeline) gets none.
- **Captions**: what the figure is first, as a noun phrase ("A sun path diagram: ..."), then how to read it (colors,
  dashes, arrows), subfigures as "(a) ... (b) ...", then scale ("Symbols, not to scale", "Magnified, discs and horizon
  true to each other"), then credits. Not how to use it: hovering, clicking and tapping are left to be found, the cursor
  hints at them. The one exception is a scene that turns, whose credit line starts with "Drag to rotate." "The chosen
  place" and "the chosen moment" for whatever the controls are set to.
- **One experiment per figure** that follows the moment and the place, last in its caption, as `<Try>`: a link that
  sets a moment and a place, named by what it sets ("Tromsø", "The year 1000"), then what the figure shows there, one
  sentence, true and checked ("the Sun never sets from May 18 to July 24"). Something worth seeing, not a tour of the
  controls. The link is the page's address with `date` (anything a JavaScript Date reads) or `jd`, and `lat`, `lon`
  and `h`; it works from outside the page as well.
- Figures render on demand, never in a continuous loop (the one exception: the corona in the eclipse figure turns
  while it shows and is in view), and are built so the later Tafeln can lift them out (colors
  from CSS tokens, UI switchable off, no reach into the chapter's DOM).
- Figures follow the theme, light or dark, which the cyanometer's step picks. A diagram is ink on paper and turns with
  the page; whatever shows the sky as it is seen (the Moon's phases, eclipses, the WebGPU skies) sits in `.as-seen`
  and stays dark. Zdog takes its colors as `themeColor("--text")` and resolves them with `themeColors` after each
  render. Captions name colors that hold in both themes ("the accent", "dashed"), never "white" or "black".
- `<Planned>` boxes for figures not yet built render under `pnpm dev` only; the published text never relies on them.

## Code examples

- Each sits in the section whose concepts it uses, led into by the sentence before it, which says what the code is
  for and ends in a period or a colon. Never "Here is an example".
- Short enough to read in one go, complete enough to copy: real imports from `@himmelszelt/<name>`, nothing hidden.
  Every import is used, and every name and signature is the library's current one; when the library changes, the
  examples change with it.
- Correct for every place and moment the controls allow, not only near Greenwich or in summer: a day starts at the
  place's midnight, not at UT's, and polar days and nights are handled or named. Prefer the call the library has for
  the job (`moon.brightLimbAngle`, `umbralMagnitude`) over rebuilding it from parts, unless the parts are the point.
  The reader's own values stay free variables (`latitude`, `longitude`); functions the reader brings (`drawMoonDisc`)
  are named as such in the lead-in.
- Lines at most 80 columns, so the block fits the text column without scrolling; long import lists wrapped.
- Comments in the same voice as the text, saying why, not what. Put a real result in a comment where it helps
  ("// 2461305.25, the offset applied", "totality on 2028-12-31, from 16:18 UTC"), and check that it is true.
- An example that runs on the page has its live output right below it, led in with a colon ("Run for the chosen day,
  place and clock:").

## Facts

Every number in the text, the captions, the glossary and the table descriptions is checked against the library's output
or a cited source before it goes in, and again when the code changes. Dates of events (eclipses, perihelion) are real
and verified. Claims about the library ("stays within 0.002°") are measured, not estimated. Simplifications are fine,
wrong claims are not: "moonlight is the lit fraction" is wrong, "the lit fraction is a first measure of moonlight" is a
simplification.

Every check is logged in `FACTS.md`: the claim, where it stands, what it was checked against, the result and the date.
A review rechecks only rows whose text, code or source changed since, and new claims; an `open` row is resolved or the
claim is rephrased.

## Draft chapters

`draft: true` shows a chapter in full under `pnpm dev` and as a placeholder in the build. While drafting, an opening
line may say the chapter is being written; it goes before publishing.
