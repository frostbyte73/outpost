# Showing a screenshot to the user

An artifact, gate draft, findings or write-draft evidence can show a screenshot inline in the PWA, on desktop and on a phone. The user clicks it to see it full size.

## Capture

Run `outpost-screenshot <http://localhost…>` with **no output path**. It writes the PNG into the daemon's screenshots dir and prints the path, which ends in a name like `1795812345678-3fa9c01b.png`.

A capture written to `/tmp/<name>.png` can't be shown. Only the default location is served.

## Cite

```markdown
![Settings page, dark](/api/screenshots/1795812345678-3fa9c01b.png)
```

The text in brackets is the label shown under the image, so make it say what the screenshot is. The full path the tool printed works too. Any other image URL renders as a plain link, not an image.

## Compare

Put two or more screenshots on consecutive lines, with nothing else in that paragraph, and they render side by side, each with its label:

```markdown
![A — current](/api/screenshots/1795812345678-3fa9c01b.png)
![B — proposed](/api/screenshots/1795812399012-77d2e4aa.png)
```

Name each option in its label (`A — current`, `B — proposed`). The user picks between them by those names.
