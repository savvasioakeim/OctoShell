# Phone companion

See what your agents are doing from your phone, and answer approval prompts while
you're away from the desk.

**Settings → Phone companion → Start sharing**, then open the address on your
phone and type the code.

## What it's for

The feature exists for one thing: when an agent hits a tool that needs approval,
it **blocks** until a human answers. Away from the desk, that agent stops dead
for as long as you're gone. Approving from your phone unblocks it.

Reading the feeds is useful too, but that is the part you could live without.

## What it is not

This is remote **control**, not cloud. OctoShell is a desktop app that owns the
terminals and the agent processes; your phone is a thin client. If the machine is
asleep, there is nothing to talk to.

## Security

The server is reachable from the public internet whenever the tunnel is up, and
it fronts a machine where agents may run with `--dangerously-skip-permissions`.
Four things carry that weight, in the order they matter:

1. **The listener only exists while sharing is on.** Stopping — or letting the
   time run out — drops the socket. There is nothing to attack, rather than
   something well defended.
2. **The code is generated, not chosen**, from OS entropy. Eight characters from
   an alphabet with no `0`/`O`/`1`/`I`/`L`, so it survives being read off one
   screen and typed on another.
3. **Five wrong codes shut the door for 15 minutes** — including for the correct
   code, so a lucky guess mid-attack doesn't get in.
4. **The code buys a token once.** After that it never travels again.

The **tunnel is not the security boundary**. It hands a public HTTPS address to
anyone who learns it; the code and the lockout are what protect the machine.

Two more, worth knowing:

- Answering an approval from the phone goes through the same path as clicking it
  on the desktop, so **whoever answers first wins** and the second answer is a
  no-op — the phone and the desk can never disagree.
- The page itself is served without a token (it holds no data, only the code
  prompt). Every data route refuses without one.

## On the same WiFi, with no tunnel at all

**Settings → Phone companion → "Also allow phones on this WiFi".**

By default the server binds to `127.0.0.1` — loopback only. That is why a LAN
address like `http://192.168.1.x:PORT` is refused no matter what your router
does: the socket never accepts anything but this machine, so there is nothing to
configure in the network.

With the toggle on it binds `0.0.0.0` too, and the panel shows a `http://<your
ip>:<port>` address with a QR code.

Worth having, because **nothing sits in the middle**: a tunnel provider
terminates TLS and can see your agents' output in plaintext, and this path avoids
that entirely. It also works with no internet.

Two costs, both real:

- **It widens access from this machine to everyone on the network.** At home that
  is your own devices; on café WiFi it is strangers. The access code and lockout
  still apply, but the door is now visible to more people.
- **It is plain HTTP, so it is not a secure context.** No service worker, which
  means **the app cannot be installed to a home screen** over LAN, and no push
  notifications. Use a named tunnel for that.

Windows will ask to allow OctoShell on private networks the first time. Say yes
for **Private** and not Public, or the phone simply times out with no clue why.

## A permanent address (and why you'd want one)

A quick tunnel's address is **random and different every session**. That's good
for security and fatal for one thing: an app saved to your phone's home screen
would open a dead address tomorrow. If you want to install it, you need a named
tunnel.

**Settings → Phone companion → Public address → Named tunnel.**

In Cloudflare: **Zero Trust → Networks → Tunnels → Create**, copy the token, and
add a public hostname pointing at `http://127.0.0.1:8787` (or whichever port you
set). Paste the token and hostname into OctoShell.

The port has to match, and cannot be random: a dashboard-managed tunnel takes its
ingress from the dashboard, and `--url` does not override that.

### Put Access in front of it

A permanent address is findable by anyone, and it points at a machine where
agents may run without asking. The quick tunnel's random, short-lived URL was
doing real work; a named one gives that up.

**Zero Trust → Access → Applications**, add the hostname, and allow only your own
email. A request then never reaches your machine without a verified identity, and
the access code becomes a second factor instead of the only one. It's free, and
the session cookie lasts as long as you configure — in practice you sign in once
a month, not every time.

This is the one part of the setup I'd call non-optional.

## The public address

"Open a public address" runs a [Cloudflare quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
no account, no DNS, no firewall change. It needs `cloudflared` on PATH:

```powershell
winget install --id Cloudflare.cloudflared
```

Without it, sharing still works — the server is just local to the machine, which
is enough to try it from a browser there.

The tunnel closes when you stop sharing or when the time runs out, and it is in
OctoShell's job object, so it cannot outlive the app even on a crash.

## Add to Home Screen

The page ships a web manifest, so your phone will offer to install it. It's a
plain web app: no store, no signing, nothing to update separately — the UI is
embedded in the OctoShell binary, so it can never be out of step with the API it
talks to.

## Notifications

Tap **🔔 Alerts** in the app once. Your phone then buzzes when an agent finishes
or stops — with the app closed, off your network, anywhere.

This uses Web Push, and it's worth being precise about what that means, because
"the browser's push service" sounds worse than it is:

**The payload is encrypted end to end** (RFC 8291). Your browser publishes a key
when it subscribes, OctoShell encrypts with it, and the push service in between
(FCM on Android) has no key. It can see that something was delivered, how big it
was and when — never what it said.

That makes it the only option that needs **no second app** and still keeps the
content private. A notification service like ntfy would need its own app
installed, and on its public instance posts to a topic anyone who learns the name
can read.

Two things follow from how it works:

- **It needs HTTPS.** Over the LAN option (plain HTTP) the button is hidden,
  because no browser will do it there — that is a rule of the web, not a
  limitation here.
- **Subscriptions belong to an address.** A quick tunnel's address changes every
  session, so the subscription dies with it. Fine for trying it; use a named
  tunnel to make it stick.

The message deliberately says only *what* happened and *where* — "the agent
finished in ridebly-client" — never the report. It is encrypted, but it still
lands on a lock screen, and the detail is one tap away.

## Sending tasks from the phone

Off by default. **Settings → Phone companion → "Let the phone send tasks to
agents"**.

Without it the phone is a window onto the machine: read, and answer approvals.
With it, the phone is a hand on the machine — whoever holds the access code can
make an agent run code here. That is why it is a separate switch from sharing
itself, rather than something you get by turning sharing on.

The task box sits at the **bottom of a project's feed**, under what the agent
just said, because on a phone the useful task is nearly always a reply to what
you are reading rather than an instruction typed blind.

Three things constrain it:

- **It refuses a busy agent** instead of interrupting it. On the desktop, typing
  while an agent works cancels the turn and queues your message — reasonable when
  you can see what you just cut short, and not something to do blind from a
  phone.
- **The switch is enforced on the machine, not on the phone.** The phone hides the
  box when it is off, but a modified client still gets refused.
- **Tasks that arrive this way are marked 📱** in the desktop feed and in the
  phone's, so a task sent over the network never looks like one typed at the
  keyboard.

## Known limits

- **The live terminal isn't streamed.** Finished command output is there; the
  command running right now is not.
