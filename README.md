# Learnbox

**Learnbox 2.0: a Mac app for exam learning.** It turns lecture PDFs into flashcards with an AI model, plans new cards per day until your exam, and teaches in chat sessions that know your course and your weakest cards. It also works offline on a phone.

> Learnbox is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist, licensed under the AGPL-3.0. It is an independent project and is not affiliated with or endorsed by the original author. See [NOTICE.md](NOTICE.md).

## What it does

- **Create.** Upload lecture PDFs and let an AI model write flashcards (brief to thorough, core knowledge marked) or multiple-choice questions. Check the drafts page by page, sort them into the topics of a course, find duplicates, and adopt them. Optional: notes per topic as Obsidian Markdown, and an audio summary per course.
- **Study.** Review with FSRS scheduling. With an exam date, the number of new cards per day is recomputed from what is still unlearned, and core knowledge comes first. Image occlusion, multiple choice, undo, pause and editing are included. Import from Anki and export as `.apkg`.
- **Lessons.** The teaching sessions of LearnHarness (measure, plan, teach, practice, with a knowledge graph) can be started for a course or from cards you get wrong. The lesson then knows your course, exam date and weak spots. Flashcards can also be made from what a lesson covered.
- **Phone.** An offline web app on the phone: pair once, choose which courses and which subdecks to keep, learn without a connection, sync answers back to the Mac. The phone reaches the Mac through Tailscale.

You bring your own AI access: API keys of your providers or the local Claude CLI. Your data stays in plain files on your machine.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no AI model, no network
```

On a Mac, `npm run learnbox:update` builds the desktop app, archives the build, installs it to `/Applications` and starts it. The build is ad-hoc signed for Intel Macs; it is not notarized. See the [development guide](docs/development.md) and [architecture](docs/architecture.md), inherited from LearnHarness.

## License

[AGPL-3.0-only](LICENSE). The program comes with no warranty. Credits and the statement of what was modified are in [NOTICE.md](NOTICE.md).

If you use Learnbox over a network, you can get its source code at <https://github.com/goddanix/LearnBox-2.0>.
