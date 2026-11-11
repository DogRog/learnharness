/**
 * The pairing page (iPad access): static HTML, no data. Served by /pair and,
 * for any unpaired remote page load, directly by Proxy, before anything
 * renders. A self-contained document, not an app page: the app layout mounts
 * providers that call the API, which refuses until the device is paired.
 */
export const PAIR_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="color-scheme" content="light dark">
<title>Pair with LearnHarness</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-icon.png">
<style>
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6862; --line: #d9d6d0; --accent: #2f5fd0; --error: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #171716; --fg: #ecebe8; --muted: #a29f99; --line: #3a3936; --accent: #7aa2ff; --error: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; }
main { width: 100%; max-width: 420px; }
h1 { font-size: 26px; margin: 0 0 8px; }
p { color: var(--muted); margin: 0 0 24px; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input { width: 100%; font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); }
#code { font-size: 32px; letter-spacing: 0.3em; text-align: center; font-variant-numeric: tabular-nums; }
button { width: 100%; margin-top: 24px; min-height: 48px; font: inherit; font-weight: 600; border: 0; border-radius: 10px; background: var(--accent); color: #fff; }
button:disabled { opacity: 0.5; }
#error { color: var(--error); min-height: 1.5em; margin-top: 16px; }
</style>
</head>
<body>
<main>
<h1>Pair this device</h1>
<p>On your Mac, open LearnHarness, go to Settings → General → iPad access, and choose Pair a device. Enter the 6-digit code it shows.</p>
<p><strong>Using the Home Screen app?</strong> It keeps its own sign-in, separate from Safari. Add this page to your Home Screen first (Share → Add to Home Screen), open it from there, and pair inside it.</p>
<form id="form">
<label for="code">Code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<label for="name">Device name</label>
<input id="name" name="name" maxlength="60" value="iPad">
<button id="submit" type="submit">Pair</button>
<div id="error" role="alert"></div>
</form>
</main>
<script>
const form = document.getElementById("form");
const error = document.getElementById("error");
const submit = document.getElementById("submit");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  submit.disabled = true;
  try {
    const response = await fetch("/api/remote-access/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: form.code.value, name: form.name.value }),
    });
    if (response.ok) { location.replace("/"); return; }
    const body = await response.json().catch(() => ({}));
    error.textContent = body.error || "Pairing failed. Try again.";
  } catch {
    error.textContent = "Can't reach your Mac. Check that LearnHarness is open.";
  } finally {
    submit.disabled = false;
  }
});
</script>
</body>
</html>`;

export function pairPageResponse(): Response {
	return new Response(PAIR_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" } });
}
