# The AI Assistant

Sitrec has a built-in assistant that both answers questions about the application and
operates it. Ask it to move the camera to a place, set the date and time, load the
satellites that were up that night, point at Jupiter, or change a menu setting, and it does
the thing rather than telling you where the control is.

Open it with **Help → AI Assistant**, or press **Tab**. It is an ordinary Sitrec window, so you
can drag it, resize it, and scroll the log with the wheel. **Tab** again, or the **X**, hides
it. The up arrow recalls what you last typed, and the **+** in its header starts a fresh
conversation.

## What it can do

The assistant is handed the same set of functions Sitrec exposes to any automation — around
a hundred of them in a loaded sitch — plus the ability to list and set every control in every
menu. "Anything you could reach through a menu" is roughly the right mental model, with a
number of extras that have no menu entry at all.

| Area | Things to ask for |
| --- | --- |
| Camera and place | "go to 51.5, -0.12 at 200 m", "put the camera at eye level", "what is the ground altitude here?" |
| Time and playback | "set the time to 21:40 on 3 June 2024", "go to frame 300", "play", "what time is it now?" |
| The sky | "point at Jupiter", "lock onto the Moon", "show me Orion's Belt", "load LEO satellites for this date", "find the satellite called Starlink-1234" |
| Menus | "use OSM imagery", "ambient lighting only", "turn the frustum off", "show satellite names in the look view" |
| Objects | "make all the objects spheres", "use a 737 model", "make it 3 m across", "add an object at 33.1, -117.3, 1500 m" |
| Views and layout | "hide the video window", "arrange the views in columns", "full screen", "hide the menu bar and the timeline" |
| Tracks and files | "what tracks are loaded?", "where is the target at frame 120?", "which files are loaded?" |
| Notes, saving, sharing | "add a note saying …", "save the sitch", "give me a share link" |
| The documentation | "how do I mask out the trees?", "what is a traverse?", "what's new?" |

Some of the more specialist things are there too, but are worth asking for by name: the Fit
Camera to Points tool, synthetic buildings, cloud layers and ground overlays, the nearest
weather-balloon soundings, and an object that walks a list of waypoints. Those four
constructors are not loaded into every conversation — the assistant asks for them when it
decides it needs them, which costs it one extra step.

Two things it deliberately cannot do. It cannot fetch a web address of its own choosing, and
it cannot write or run a [scripted camera move](ScriptedVideo.md), because those scripts are
real code. Both are withheld because a sitch opened from a link can contain text somebody
else wrote — see [Your API Keys](APIKeys.md) for the reasoning.

## Some commands never reach a model

A small pattern matcher inside Sitrec recognises common phrasings and carries them out on the
spot, with no model involved: `play`, `pause`, `frame 300`, `zoom in`, `load starlink`,
`ambient only`, `vFOV = 0.7`, `go to Denver`, `point at Saturn`, `what is 2+2`. You will
notice these because they answer instantly.

Anything it does not recognise goes to the model, and anything beginning "how" or "why" always
goes to the model — those are questions, and letting the pattern matcher guess at them turned
"how do I get a track of az/el" into a toggle being switched on.

## It changes your sitch

Most of what the assistant does is a real edit, not a preview. When a call changes anything
that gets saved, Sitrec marks the sitch as having unsaved changes, exactly as if you had made
the change yourself: closing the tab warns you, and **File → Save** writes a new version. Camera
moves, time changes, playback and view layout do not count as changes, because they are not
saved with the sitch.

**Undo covers the assistant's edits exactly as far as it covers your own, which is not
everything.** Creating an object, adding a synthetic building or cloud layer, and placing camera
fit points can all be undone with **Ctrl+Z**. Most menu settings cannot be undone, whoever
changed them. If you are about to ask for something sweeping — "make all the objects spheres" —
save first.

The assistant can also undo and redo on request, which drives the same stack: "undo that" works.

**Sitches you did not make ask for confirmation.** If the loaded sitch came from a link or
another external source, the first thing the assistant tries to do that changes saved state or
sends data outward raises a dialog naming the function, with **Allow once**, **Trust this sitch**
and **Don't allow**. Reading and analysing an external sitch is unaffected — the guard is on
what the assistant can *do*, because a shared sitch's notes and labels were written by whoever
shared it.

## Getting good results

**Say what you want to happen, not which control to use.** The assistant looks up controls by
partial name, so "turn the frustum off" finds "Camera View Frustum" without you knowing that is
what it is called.

**Ask for several things in one message.** A single turn can make several calls, and it is
explicitly instructed to complete every part of a request. "12:21 pm today in New York, looking
at the Moon" is one message, not three.

**It will chain calls to work things out.** It can list a menu's controls, read a value, then
set it, and a single turn runs several rounds of that before it answers. That is also how it
repairs a mistake — a wrong control name comes back to it as an error it can read and try
again with.

**Ask it to check the documentation.** It can read any of the help pages in this documentation
set, and phrasing a question as a question ("how do I stabilize the video?") is what prompts it
to. Its answer will normally include a link to the page it read, so you can check it.

**Be specific about units and datums** — metres or feet, local time or UTC, altitude above the
ground or above sea level. It will otherwise pick a reasonable default, and reasonable is not
always right.

**"Point at" and "lock onto" are different requests.** Point moves the camera once and leaves
it there; lock keeps following the object as time advances. Say which you mean.

**Check what it did.** If a call fails and the assistant cannot repair it, Sitrec prints the
error itself, so a silent "Done." with something plainly unchanged is worth a second look.

## Choosing a model

**Settings → AI Model** picks which model answers. The same dropdown is mirrored into the
Assistant window's own header menu, so you can change it without leaving the conversation.

There are four routes, and they differ in who pays and where the conversation goes.

| Route | How it appears in the list | Who pays | Where the conversation goes |
| --- | --- | --- | --- |
| Sitrec's own models | a plain name, e.g. "GPT-5 Mini" | Sitrec | your browser → Sitrec's server → the provider |
| Auto (economy) | "Auto (economy)" | Sitrec | as above, with the model picked for you |
| Your own key | marked "(your Anthropic key)", "(your OpenAI key)" or "(your OpenRouter key)" | you, at the provider | your browser → the provider, directly |
| Your own server | marked "(your endpoint)" | you, or nobody | your browser → the address you set |

**Sitrec's own models** need you to be logged in, and which ones you are offered depends on
your account: a plain account gets the cheapest capable models, and the supporter tiers add
more models and a higher rate limit. Logged out, the list is empty and you will need one of the
other routes.

**Auto (economy)** is the last entry in that list. It prices every model your account can reach
against the shape this assistant's requests actually have — a large prompt and a fairly short
reply — and picks the cheapest. Use it if you have no reason to prefer a particular model.

**Your own key** and **your own server** are set up in **Settings → API Keys…**. Which models
appear, what a custom endpoint needs, and what happens to your key are all covered in
[Your API Keys](APIKeys.md).

The choice is not only about money. A smaller or cheaper model is noticeably less reliable at
multi-step requests: it is likelier to do the first half of a two-part instruction, to pick the
wrong control, or to say it has done something it has not. If a request keeps going wrong, try
it on a larger model before concluding Sitrec cannot do it.

**Sitrec Focused** is on by default, in Settings and the Assistant header menu. For models
using **your own API key or custom endpoint**, turn it off to discuss any topic. It also
applies to the spoken assistant and updates an active voice session immediately. Sitrec's
own models always retain their Sitrec topic restriction. The preference is saved with your
settings, and changing it takes effect on the next typed request.

Turning focus off shows an **API usage costs** notice. General conversations still send the
Sitrec instructions and recent chat history, and longer conversations or replies can use
more tokens. Your provider's charges apply. Review usage and local limits in
**Settings → API Keys…**, and set spending caps or budget alerts with the provider;
Sitrec's local limits are not provider billing controls. See [Your API Keys](APIKeys.md).

## The header bar

The Assistant window's header shows the name of the model that is currently answering. It is
read from the setting each time rather than remembered, so it is right after you change models,
after a saved session is restored, and after the assistant changes the setting itself.

While the microphone is live it shows the voice model instead, prefixed with a microphone
glyph, because that is a different model on a different API and costs roughly an order of
magnitude more per turn.

## Speaking to it

The 🎤 button in the Assistant header starts a spoken conversation. There is a second
microphone button in the main menu bar, to the left of the version number, which does the same
thing and opens the Assistant window if it is closed.

The spoken assistant is the same assistant: same instructions, same tools, same guards. Only
the model and the medium differ. It is told to keep replies to a sentence or two, to do the
thing before describing it, and never to read out markup, URLs or node ids — so it behaves
differently from the typed one even though it can do the same things. You can interrupt it, and
typing while it is listening adds your text to the same spoken conversation rather than starting
a second one.

While a session is running, **both** microphone buttons turn into a pulsing red badge, and the
menu-bar one reads **REC**. Either one stops the session, and so does closing the Assistant or
loading a different sitch. The menu-bar button is the one to rely on: the Assistant window can
be scrolled, hidden or covered, and the menu bar cannot.

**Settings → Voice Model** chooses which realtime model is used; it is mirrored into the
Assistant header menu alongside AI Model. The spoken assistant requires **your own OpenAI key** —
there is no Sitrec-provided route for it — and pressing the button without one gives you a
message saying where to add it. Your microphone audio is streamed to OpenAI while the session
is open, and spoken tokens cost far more than typed ones. Both points are covered properly in
[Your API Keys](APIKeys.md); read that section before you start using it heavily.

## What it is not good at

It is worth being straight about the limits.

- **It is instructed to stay on the subject of Sitrec.** It will decline unrelated topics,
  including people, events and politics.
- **It cannot see.** It has no access to the video frames, the rendered 3D view, or a
  screenshot. It knows the scene only through what it can query — track positions, menu
  values, the camera, the clock. "What is that bright thing in the corner?" is not a question
  it can answer.
- **It has a short memory.** Only about the last ten messages of a conversation are sent, so a
  detail you gave twenty messages ago is gone. Repeat what matters, or start a new chat when
  you change subject.
- **It can misunderstand and act anyway.** The instructions push it to act rather than ask,
  which is what makes it useful and also what makes a misread request change something you
  did not want changed. Check the result.
- **It does not know your sitch's history.** It sees the current state, not why you set it up
  that way. It cannot tell you whether a reconstruction is sound — that is
  [Doing Defensible Analysis](DefensibleAnalysis.md), and it is a judgement, not a lookup.
- **Documentation answers can be truncated.** A very long help page is cut off when it is read,
  and the assistant is told to say so when that happens. If it warns you its answer may be
  incomplete, open the page itself.

## Privacy in short

On Sitrec's own models, your message, the recent conversation, a description of the loaded
sitch's menus and the results of any tool calls go to Sitrec's server, which passes them to the
model provider on its own account. On your own key or your own server, the same material goes
straight from your browser to the provider or address you chose, and Sitrec's server sees
neither the credential nor the conversation.

Nothing in either path includes your stored API keys: the assistant is never told them and has
no tool that can read one.

**Your prompts are not kept.** Sitrec's server passes a conversation to the model provider and
does not retain it. There is a development log of what people asked the assistant, but it now
records only the maintainer's own account — the check is in the server endpoint itself, not
just in the browser, so nothing else reaches it. The bring-your-own-key and your-own-server
routes never touched that log at all, since they do not go through Sitrec's server.

What the model *provider* keeps is a separate question, and theirs rather than Sitrec's: each
one has its own retention policy, and on your own key or your own server that relationship is
directly between you and them.

The full account of what is stored where, what protects it, and what does not, is in
[Your API Keys](APIKeys.md).
