# Privacy

Nothing you read leaves your device. No telemetry. This file is generated from `spec/network.json`
(`scripts/privacy-md.mjs --check` runs in CI, so it cannot drift out of sync) -- don't hand-edit it.

## Web (the browser demo)

The web app makes network requests for exactly two things, and nothing else:

1. **Downloading the AI models it needs**, straight from the Hugging Face Hub, at an exact,
   pinned file version -- never the latest version of a model, so nothing changes under you between
   visits. Every file it can ever request is listed in `spec/network.json`.
2. **Following the Hub's own redirects** for those same files, to one of: us.aws.cdn.hf.co, huggingface.co, *.cdn.hf.co.
   These are Hugging Face's own file-serving infrastructure, not a third party we chose.

That's it. Every request is a `GET`. No analytics, no crash reporting, no ping of any kind. The
text you paste or select, the bullets it generates, and the audio it plays are never sent
anywhere -- they exist only in your browser's memory while the page is open. A Content-Security-Policy
on every page enforces this list in your browser, not only in our own code.

## macOS app

The Mac app makes the same two web requests above, plus:

3. **License checks (Polar).** If you've entered a license key, the app validates it at most once
   a week. A failed check nags you to fix it -- it never locks you out of the app.
4. **Update checks (Sparkle).** The app checks a fixed URL (`https://aj-prabhu.github.io/fruitbat/appcast.xml`) for new releases. This is
   disclosed the first time you open the app and can be switched off in Settings at any time.
5. **A bug report, only if you choose to send one.** It opens a prefilled GitHub issue in your own
   browser; you review it and press send yourself. The app never files it for you.

Logs on both platforms are numbers and category names only -- never the text you read, the bullets
generated from it, audio, file names, or URLs of what you were reading.

## The exact list

`spec/network.json` is the source of truth: every exact URL, every redirect host, every allowed
method, per target. This file is generated from it.
