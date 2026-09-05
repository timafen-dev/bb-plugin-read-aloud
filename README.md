# Read Aloud

**Hear any BB message.** Adds a *Read aloud* action to every chat message — the
agent's answer, your own prompt, or just the paragraph you highlighted — and
speaks it in a natural OpenAI voice.

BB has no text-to-speech of its own. This plugin adds it in the one place it
belongs: the per-message action bar, and the text-selection menu.

## What it does

- **One click per message.** The action appears on every user and assistant
  message. Click again to stop; clicking another message replaces the reading
  rather than talking over it.
- **Read only what you selected.** Highlight a paragraph inside an answer and
  the selection menu reads exactly that.
- **Reads prose, skips noise.** Fenced code blocks are dropped, and markdown
  syntax — headings, bullets, links, emphasis, tables — is stripped so you hear
  the words, not the punctuation.
- **Long messages work.** OpenAI caps one request at 4,000 characters; longer
  messages are split at paragraph and sentence boundaries and played as one
  continuous take.

## Setup

1. Install the plugin.
2. Create an API key at [platform.openai.com](https://platform.openai.com/api-keys).
3. Paste it into **Settings → Plugins → Read Aloud → OpenAI API key**.

A ChatGPT subscription cannot be used here, and this is worth stating plainly:
OpenAI does not admit subscription tokens to its speech endpoint. It answers
`401 Missing scopes: api.model.audio.request`. Only the realtime conversation
API accepts them, which is why a live voice assistant can run on a subscription
while "read this text" cannot. So this plugin uses the platform API and your own
key — which also means it works for anyone who installs it, with no other
account or CLI required.

## Settings

| Setting | Meaning |
| --- | --- |
| OpenAI API key | Stored as a server-side secret; never reaches the browser. |
| Voice | One of the eleven OpenAI voices. Previews are in the [voice guide](https://platform.openai.com/docs/guides/text-to-speech#voice-options). |
| Model | `gpt-4o-mini-tts` (default, cheapest and most expressive), or the older `tts-1-hd` / `tts-1`. |
| Reading style | Plain-language direction, e.g. *"calm, unhurried, like a colleague explaining"*. Followed by `gpt-4o-mini-tts` only. |

## Cost

Billed to your OpenAI account, not to BB. At the time of writing
`gpt-4o-mini-tts` is roughly **$0.015 per minute of speech** — about a dollar
for an hour of listening. Check
[current pricing](https://openai.com/api/pricing/) before relying on that number.

## Privacy

The message text is sent to OpenAI to be spoken, and nowhere else. The API key
stays on the BB server as a secret setting. Audio is generated per click, played
from memory, and released when it finishes — nothing is written to disk or
cached.

## License

MIT
