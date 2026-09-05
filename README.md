# Read Aloud

**Hear any BB message.** Adds a *Read aloud* action to every chat message — the
agent's answer, your own prompt, or just the paragraph you highlighted — and
speaks it out loud.

BB has no text-to-speech of its own. This plugin adds it in the one place it
belongs: the per-message action bar, and the text-selection menu.

## What it does

- **One click per message.** The action appears on every user and assistant
  message. Click again to stop; clicking another message replaces the reading
  rather than talking over it.
- **Read only what you selected.** Highlight a paragraph inside an answer and
  the selection menu reads exactly that.
- **Long messages start immediately.** The text is split at paragraph and
  sentence boundaries and played as a queue: the first piece is speaking while
  the next is still being made, so a long answer begins in about a second
  instead of after ten seconds of silence.
- **Reads prose, skips noise.** Fenced code is dropped, markdown syntax is
  stripped, links become "ссылка", file paths become "file name.py", and long
  hashes become "version" — you hear the words, not the punctuation.
- **Nothing leaves your machine.** By default the speech is made by a local
  engine you run yourself.

## Setup

```sh
git clone https://github.com/timafen-dev/bb-plugin-read-aloud
cd bb-plugin-read-aloud
./engine/install-tts.sh          # builds and starts the local speech engine
bb plugin install .              # or install from git, see below
```

`install-tts.sh` needs Docker. It builds the engine image, starts a container
that comes back after a reboot, downloads the voices, and does not return until
the engine answers. The engine listens on **127.0.0.1 only**.

## Engines

| Engine | Licence | Cost | Notes |
| --- | --- | --- | --- |
| **Piper** (default) | MIT | free | Runs locally. Russian voices `ru_RU-dmitri-medium`, `ru_RU-irina-medium`, `ru_RU-denis-medium`, `ru_RU-ruslan-medium`, plus every other Piper voice. On an ordinary laptop CPU it synthesizes roughly twenty times faster than real time. |
| Silero | **CC BY-NC-SA — non-commercial only** | free | Better regarded for Russian by some. Not installed by default: if you use BB for commercial work, that licence is your problem to weigh. |
| OpenAI | commercial API | ~$0.015 per minute | Opt-in. Needs your own platform API key. |

A ChatGPT subscription cannot drive any of this, and it is worth stating
plainly: OpenAI refuses subscription tokens at its speech endpoint with
`401 Missing scopes: api.model.audio.request`. Only the realtime conversation
API accepts them — which is why a live voice assistant can run on a
subscription while "read this text" cannot.

## Settings

| Setting | Meaning |
| --- | --- |
| Speech source | `local` (default) or `openai`. Nothing switches itself on. |
| Voice | A Piper voice id, or an OpenAI voice name. |
| Speed | 1 is normal; 0.5 is half, 2 is double. |
| Local engine address | Default `http://127.0.0.1:5077`. |
| Machine | Blank means the machine the open thread runs on. Set a host id to pin every reading to one machine. |
| OpenAI API key | Server-side secret; never reaches the browser. Used only when the source is `openai`. |

## How it is put together

The plugin server runs inside the BB server, which on most installs is not the
machine you work on — so it cannot reach a local engine directly. A **host
entry** (`bb.host`) runs on your machine and is the only part that talks to the
engine. The engine itself sits behind one small HTTP contract — `/health`,
`/voices`, `/speak` — so swapping Piper for something else needs no change in
the plugin.

Audio is cached by a hash of engine, model version, voice, speed and text, so
listening to the same message twice is instant and free. The cache is capped at
500 MB and drops the least recently used.

## Privacy

With the default local engine, no text leaves your machine. With OpenAI
selected, the message text is sent to OpenAI to be spoken and nowhere else.

## Licence

MIT for this plugin. The voices you install carry their own licences — see the
table above.
