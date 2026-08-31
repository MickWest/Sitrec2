# Your API Keys: where they are stored and how they are protected

Sitrec lets you supply your own API keys — for the AI assistant, for Google's 3D tiles,
for Cesium Ion, and for other providers — instead of using Sitrec's shared quota. You
manage them in **Settings → API Keys…**.

Handing an application a credential is a real decision, so this page explains exactly what
Sitrec does with it, what protections exist, what they do *not* cover, and how to limit the
damage if something goes wrong. It describes what the code actually does today, including
the parts that are still weak.

---

## The short version

- Your keys are stored **only in your own browser**, in IndexedDB, on the machine you typed
  them into. They are **never sent to the Sitrec server**.
- Each key is sent **only to the provider it belongs to** — your Anthropic key to
  Anthropic, your OpenRouter key to OpenRouter, your Google key to Google, and so on.
- Sitrec **never displays a stored key back to you**, not even the last few characters. The
  dialog shows only "Set" or "Not set".
- Keys are **obscured at rest**, so they are not sitting in the database as readable text.
  This is a guard against accidental exposure, **not** real encryption — see below.
- Anything that can run JavaScript on the Sitrec page can still obtain them.
- Use **narrowly scoped keys with spending limits set at the provider**. That is the single
  most effective protection, and it is the one thing Sitrec cannot do for you.

---

## Where the keys are stored

Keys live in your browser's **IndexedDB**, in a database named `SitrecDB`, in the
`settings` object store, under names prefixed `byok_` — for example `byok_anthropic`,
`byok_openrouter`, or `byok_google-maps`.

IndexedDB is **origin-scoped**: data saved by `https://www.metabunk.org` can only be read
by pages served from `https://www.metabunk.org`. Another website cannot read Sitrec's
storage, and Sitrec cannot read another site's.

Practical consequences of storing them there:

- They stay on **one browser on one machine**. They do not sync to other devices, and they
  are not part of your Sitrec account.
- They **survive a reload** and a browser restart, which is the point — you enter a key
  once, not every session.
- Clearing site data, browsing "cookies and site data", or using the browser's "forget this
  site" will delete them, along with your other Sitrec settings.
- A **private/incognito window** gets its own storage that is discarded when the window
  closes.

### They are obscured, not encrypted

Stored values are wrapped with AES-GCM before being written, so what sits in the database is
an opaque blob beginning `sitrec-obf-v1:` rather than a recognisable `sk-ant-...` string.

**Be clear about what this is worth.** The passphrase used to wrap them is a fixed value
compiled into Sitrec's public JavaScript. Anyone who wants the plaintext can read that
passphrase out of the published code and unwrap the value in seconds. This is *obfuscation*,
and calling it encryption would be misleading.

It is still worth doing, because the realistic exposures are accidents rather than attacks:

- a screenshot or screen-share showing the browser's storage inspector
- a browser-profile backup, sync blob, or disk image read casually
- a support request where someone pastes their stored settings

In each of those, a plaintext key is instantly recognisable and instantly usable by whoever
sees it; an opaque blob is not. It buys nothing at all against software running on the page,
which can simply ask Sitrec for the key and be handed it.

Genuine encryption at rest would require a passphrase **you** type each session, so the
unwrapping secret is never stored alongside the data. Sitrec does not currently offer that.

---

## Where the keys are *not* stored

This matters as much as where they are, so it is enforced in several independent places:

**Never in your Sitrec settings.** Sitrec's settings are sanitised and can be saved to the
Sitrec server and to a cookie. Keys are deliberately kept in a *separate* storage namespace
so they never pass through that path. As a second layer, both the browser-side and
server-side settings sanitisers are **allowlists** — they copy only the specific known
settings fields and silently drop everything else — so even a bug that put a key into the
settings object would not get it as far as the server.

**Never in a saved or exported sitch.** A sitch records the scene, not your credentials.
Sharing a sitch file, or a share link, does not share your keys.

**Never in the AI assistant's context.** The assistant is never told your key, and it has no
tool that can read it. This matters because a sitch loaded from a link can contain text
written by someone else, and that text can try to manipulate the assistant. It cannot make
the assistant reveal a key it was never given.

**Never in Sitrec's usage logs.** When you use your own key, the request goes straight from
your browser to the provider. Sitrec's server is not involved and does not count it — your
usage on your own key is not reported to Sitrec at all. Usage figures shown in the API Keys
dialog are counted locally, in your browser, for your benefit.

**Never in the interface.** No label, tooltip, menu, or chat message contains any part of a
key. This is deliberate and was tightened after review: menu labels in Sitrec are collected
and sent to the AI provider as part of describing the app, so a key fragment in a label
would have travelled further than expected. The dialog shows only "Set", "Off" or "Not set".

**Keeping a key without using it.** Each row in the dialog has a tick box. Clearing it
leaves the key stored but stops Sitrec reading it, so that service falls back to Sitrec's
own shared quota — useful for running a session on Sitrec's account without having to paste
the key again afterwards. The row then reads "Off". Untick every AI key and the "(your key)"
entries disappear from the AI Model list, exactly as if no key were stored.

---

## Where each key *is* sent

Each key goes to exactly one destination — the provider that issued it:

| Key | Sent to | Purpose |
|---|---|---|
| Anthropic | `api.anthropic.com` | Runs the AI assistant on your account |
| OpenAI | `api.openai.com` | Runs the typed and spoken assistant on your account |
| OpenRouter | `openrouter.ai` | Runs OpenAI-family models through OpenRouter on your account |
| Google | `tile.googleapis.com` | Photorealistic 3D tiles |
| Cesium Ion | Cesium Ion servers | Terrain and building tilesets |
| Windy | `api.windy.com` | Worldwide live webcams |
| AISStream | `stream.aisstream.io` | Worldwide live ship positions |
| TomTom | `api.tomtom.com` | Live road traffic incidents |
| Mapbox / MapTiler | Their tile servers | Map imagery |
| Space-Track | `space-track.org` | Satellite element sets |

These requests go **directly from your browser to the provider**. They do not pass through
the Sitrec server, which means Sitrec cannot see them — and also means the provider sees
your browser's IP address rather than Sitrec's.

For OpenRouter, the key itself goes only to OpenRouter, but the request is routed onward to
the selected upstream model provider. That means the Sitrec system instructions, your chat
history and current message, tool definitions, and tool results are visible to OpenRouter
and to that upstream provider. Do not use this route for material you are unwilling to send
to both services.

Two consequences worth knowing:

- **The provider's own dashboard is the authority** on your usage and spend. Sitrec's
  figures are a local estimate to help you notice a problem early.
- Some providers do not permit direct browser access at all, which is why not every service
  can be used this way.

### The OpenAI key

The **OpenAI** key runs both halves of the assistant on your account: the typed chat, via
the "(your OpenAI key)" entries in the AI Model list, and the microphone button in the
Assistant window.

It was voice-only until recently, and you may still see that written elsewhere. The reason
was real and has expired: `api.openai.com` used to refuse a browser's cross-origin request
to its text endpoints, so the only way to reach GPT from the page was through OpenRouter.
It now allows them, so the extra hop is optional. OpenRouter remains useful for reaching
models OpenAI does not serve, and it reports the exact charged cost of every request, which
OpenAI does not — Sitrec estimates that from published prices instead.

Three things about the spoken assistant are worth knowing before you supply a key:

- **Your microphone audio leaves your browser.** While a voice session is running, what
  your microphone hears is streamed live to OpenAI, along with the same Sitrec system
  instructions, tool definitions and tool results a typed session sends. The connection is
  browser-to-OpenAI; the Sitrec server is not in the path and sees none of it. The session
  starts only when you press the microphone button, and it ends when you press it again,
  close the Assistant, or load a different sitch.
- **Your browser will ask for microphone permission.** If you refuse, nothing is sent and
  no request is spent.
- **Spoken tokens cost far more than typed ones.** On the voice model, audio input is
  billed at about eight times the text rate and audio output at nearly three times. A long
  conversation is much more expensive than the same conversation typed. Sitrec's usage
  readout reports audio and text tokens separately for exactly this reason, and the
  spending limit you set at OpenAI is the protection that actually binds.

While the session is live, **both** microphone buttons — the one in the Assistant header and
the one in the menu bar, left of the version number — turn into a pulsing red badge, and the
menu-bar one reads **REC**. Either one stops the session. The menu-bar button is the
dependable indicator: the Assistant window can be scrolled, closed or hidden behind
another, and the menu bar cannot.

---

## What protects the keys

**Origin isolation.** Browsers prevent one site reading another's IndexedDB. This is the
main structural protection and it is enforced by the browser, not by Sitrec.

**No display, anywhere.** A key that is never rendered cannot be read over your shoulder,
captured in a screenshot, or copied into a bug report or screen recording. When you replace
a key, the field starts empty rather than pre-filled with the old one, so the stored value
is never put back on screen. Entry fields are password-type.

**Separate storage namespace plus allowlist sanitisers**, as described above — two
independent mechanisms that must both fail before a key could reach the server.

**Escaping untrusted text in the interface.** Sitrec displays names that come from files you
open — track names from a KML, titles from a shared sitch. Those are inserted as plain text,
never as markup, so a maliciously named file cannot inject code into the page and read your
storage. This was hardened specifically because storing credentials raises the stakes: the
underlying weakness existed before, but there was less worth stealing.

**Restricting what the AI assistant can do.** The assistant cannot fetch a web address of
its own choosing, so text hidden in a shared sitch cannot instruct it to send your data
somewhere. New functions that could do so must be explicitly reviewed before they can be
added — this is checked automatically when Sitrec's code changes.

---

## What is *not* protected — please read this part

**Anything running on the Sitrec page can read the keys.** IndexedDB is readable by
JavaScript on the same origin. That includes:

- **Browser extensions** you have installed that are permitted to run on the page.
  Extensions are outside Sitrec's control entirely.
- **A cross-site scripting flaw in Sitrec.** Sitrec escapes untrusted text at the points
  known to matter, and this is tested automatically, but no application can promise it has
  found every such flaw. Code running on the page can read the stored values *and* unwrap
  them, because it has the same fixed passphrase the app does.

**Sitrec's Content-Security-Policy is partial.** It blocks a few specific injection routes
(`object-src`, `base-uri`, `form-action`), but it does **not** restrict which addresses the
page may send data to. That restriction — the one that would contain an exfiltration attempt
— is not currently possible, because Sitrec can be asked to load a situation file from *any*
web address, and that feature and a restrictive policy are mutually exclusive. This is a
known limitation, recorded here rather than glossed over.

**Anyone with access to your computer or browser profile** may be able to recover the keys.
The obfuscation described above makes casual discovery harder, but it is not a barrier to
anyone who is actually looking. A shared or unlocked machine means shared keys.

**Sitrec cannot limit your spending at the provider.** The daily limits in the API Keys
dialog are enforced in your browser only. They are a useful guard against a session quietly
running up a bill, but they are not a billing control: clearing site data resets them, and
they cannot restrict anything outside Sitrec.

---

## Recommended practice

1. **Create a key for Sitrec alone**, not one reused across projects. Then revoking it
   affects nothing else.
2. **Restrict the key at the provider.** Most allow limiting a key to specific APIs, and
   Google keys can be restricted to specific websites (HTTP referrers). A key restricted to
   the Maps Tiles API and to the Sitrec address is of little use to anyone who steals it.
3. **Set a spending cap or budget alert with the provider.** This is the only limit that
   cannot be bypassed by clearing browser data.
4. **Set a daily limit in the API Keys dialog** as an early warning, in addition to (not
   instead of) the provider's cap.
5. **Do not use your own keys on a shared or public computer.**
6. **Check the provider's dashboard occasionally.** It is the authoritative record.
7. **Remove keys you have stopped using** — "Clear" in the dialog deletes the stored value.

---

## Removing a key

Open **Settings → API Keys…** and press **Clear** on that provider. The stored value is
deleted from IndexedDB immediately.

Clearing the browser's site data for Sitrec removes all of them at once, along with your
other Sitrec settings.

If you believe a key may have been exposed, **revoke it at the provider**. Deleting it from
Sitrec removes your copy, but only the provider can invalidate a key that has already been
copied elsewhere.
