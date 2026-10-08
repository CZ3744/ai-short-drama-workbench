<div align="center">

# AI Video Studio

### Make the story work. Then make the shot.

Scripts, storyboards, references, clips, and export — in one local workspace, with your own model providers.

[简体中文](README.md) · [Real screenshots](docs/SHOWCASE.md) · [Setup guide](docs/GETTING_STARTED.md)

![AI Video Studio product overview](docs/media/product-overview.png)

</div>

Making an AI short film involves more than pressing Generate. You revise a scene, find the right character reference, adjust a prompt, compare clips, and do it again.

This studio keeps that work together. Go back to one shot and keep editing. Bring in scripts and media you already have, or connect your own providers when you need new material.

## What you can do

- **Write and revise:** edit scripts by episode, keep versions, and see whether your changes have saved.
- **Plan the shot:** manage storyboards, characters, scenes, and references. Inspect the prompt and references in supported image workflows before sending a request.
- **Finish with your own media:** choose generated candidates or import existing files, then assemble clips with subtitle and composition settings.

![Actual script editor with a fictional sample](docs/media/source/script.png)

The app currently uses a Chinese interface. The overview image is a promotional composition based on actual screenshots. [Unedited captures and sample details](docs/SHOWCASE.md) are available; sample artwork is not a claim about cloud generation quality.

## Run locally

Recommended: **Windows and Node.js 24**. Windows has received the most complete hands-on verification; macOS and Linux have not received equivalent testing.

```sh
git clone https://github.com/CZ3744/video-generate-studio.git
cd video-generate-studio
npm ci
npm run doctor
```

On Windows, double-click `start-studio-hidden.vbs`. It starts quietly and opens the browser when ready. Use `stop-studio.vbs` to stop this project's services.

Alternatively, run `npm run dev` and open [127.0.0.1:5173](http://127.0.0.1:5173). Create a series, write a short script, wait for it to save, and refresh to check it. No API key is needed for this first step.

To generate content, add your providers in Settings. Composition requires FFmpeg and FFprobe on PATH; check them with `npm run doctor -- --require-media`.

An AI coding assistant can follow the [local setup instructions](docs/AI_SETUP.md). They include environment checks and a real save-and-refresh verification, without requiring cloud deployment.

## What to expect

The tool is MIT licensed. You supply your own API keys and pay your chosen providers. Supported integrations are shown in Settings; arbitrary video APIs are not universally supported.

Projects and settings live on your computer. Cloud generation sends the necessary prompts, media, and credentials to the provider you choose. Local demo cards are placeholders for learning the workflow, not AI image results. This is a personal local application, not an authenticated multi-user hosting service.

Version 0.2.x is under active refinement. Isolated tests and browser checks cover local behavior; they do not guarantee every paid provider's availability or output quality.

[FAQ](docs/FAQ.md) · [Privacy](docs/DISTRIBUTION.md) · [Contributing](CONTRIBUTING.md) · [Release notes](docs/RELEASE_NOTES.md) · [Assistant documentation index](llms.txt) · [MIT](LICENSE)

If it helps your workflow, a Star makes it easier to find again. If a step gets in your way, [open an issue](https://github.com/CZ3744/video-generate-studio/issues) with a small, sanitized example.
