# Changelog

## [0.3.0] - 2026-11-16

### Added

- Models the official catalog does not know now take the context window and input types that vLLM, SGLang and llama.cpp servers report, instead of a 128k text-only default. The model checklist says where each model's metadata comes from (based on [#1](https://github.com/BlueOcean223/pi-provider/pull/1) by [@DolbyDAX2](https://github.com/DolbyDAX2))

### Changed

- Removed the display name setting from the provider page and from the add flow's review page. pi shows a provider's name only in `/login` and `/logout`, and `/model` always shows the provider id. A `name` already in `models.json` is left as it is.

### Fixed

- A long note above the model checklist, such as the error body of a relay that rejects the model list request, no longer makes pi exit with `Rendered line exceeds terminal width`. Notes now wrap, stay indented under the title, and end with an ellipsis after three lines ([#2](https://github.com/BlueOcean223/pi-provider/pull/2) by [@Banboosu](https://github.com/Banboosu))

## [0.2.3] - 2026-10-14

### Fixed

- A dialog that is open while the theme changes now takes the new colours. Unfocused checklist labels use the terminal's default colour, so they stay readable when the theme does not match the terminal's background.

## [0.2.2] - 2026-10-04

Tagged in git only; not published to npm.

### Fixed

- Every panel now fits into the rows pi leaves it in fullscreen mode, where a taller panel was cut off at the bottom together with its key hints and the test verdict. Lists shorten or scroll with the cursor, and the test panel shows a window of checks with a line saying how many are above and below.

## [0.2.1] - 2026-09-23

### Fixed

- On a narrow terminal, a list row now shortens its detail text before the badge at its end, so the last test result stays visible.

## [0.2.0] - 2026-09-23

- `/provider` opens the provider list. Each provider has a page whose rows (base URL, protocol, API key, compat, models) are edited in place and saved immediately.
- The add flow asks for the base URL, key and protocol, lists the endpoint's models, and ends on a review page where every field can still be changed. Saving runs the test panel.
- Chat tests go through pi's model registry, so they use pi's own credentials, headers, compat flags and request shape.
- The test panel shows each model's latency. It can switch to a passing model, apply the compat flag a relay's error points at and test the failures again, and remove failing models.
- One model checklist per provider: configured models are checked, models new on the relay are marked, and delisted ones are flagged.
- Presets for Ollama, LM Studio and vLLM. `/provider <id>` opens that provider's page.
