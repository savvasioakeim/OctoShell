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

## Known limits

- **No push notifications yet.** You have to open the app to see that an agent is
  waiting. This is the next thing worth building.
- **The live terminal isn't streamed.** Finished command output is there; the
  command running right now is not.
- **Read and approve only.** You cannot dispatch new tasks from the phone. That
  is deliberate for now: a good task prompt needs context that is awkward to
  write on a phone, and it is the highest-risk thing the companion could do.
