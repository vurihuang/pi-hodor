# pi-hodor

[![npm version](https://img.shields.io/npm/v/pi-hodor)](https://www.npmjs.com/package/pi-hodor)
[![npm downloads](https://img.shields.io/npm/dm/pi-hodor)](https://www.npmjs.com/package/pi-hodor)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`pi-hodor` is a pi extension that automatically sends a follow-up retry message when an assistant response fails because of transient streaming or connection errors.

It is useful when model output is interrupted by provider-side failures such as `ECONNRESET`, `ETIMEDOUT`, premature stream closure, or partial JSON responses. Instead of stopping and waiting for manual intervention, the extension detects the failure and sends a configurable retry message such as `continue`.

## Features

- Watches assistant messages that end with `stopReason === "error"`
- Matches the error text against configurable substring patterns
- Automatically sends a retry message when a match is found
- Prevents runaway loops with a configurable retry limit
- Optionally shows UI notifications when an auto-retry happens
- Supports project-level config overrides without modifying the packaged files

## Installation

Install from npm:

```bash
pi install npm:pi-hodor
```

Or from git:

```bash
pi install git:github.com/vurihuang/pi-hodor
```

Restart pi after installation so the extension is loaded.

### Load it for a single run

```bash
pi -e npm:pi-hodor
```

### Install from a local path

```bash
pi install /absolute/path/to/pi-hodor
```

### Load from a local path for one session

```bash
pi -e /absolute/path/to/pi-hodor
```

## Verify installation

After restarting pi, the extension is active automatically.

You can confirm it is loaded by triggering a transient stream error during normal use, or by checking that the extension has been installed from npm and is available in your pi package list.

## Usage

Once the extension is loaded, there is nothing else to trigger manually.

When pi receives an assistant message that:

1. ends with an error stop reason, and
2. contains one of the configured error patterns,

`pi-hodor` automatically sends the configured retry message.

The default retry message is:

```json
"continue"
```

## Configuration

Configuration is resolved in this order:

1. `./.pi-hodor.json`
2. `./.pi/pi-hodor.json`
3. the bundled `config.json` inside this package

This keeps the package defaults intact while allowing per-project overrides.

### Example config

```json
{
  "enabled": true,
  "retryMessage": "continue",
  "maxConsecutiveAutoRetries": 99,
  "notifyOnAutoContinue": true,
  "errorPatterns": [
    "error decoding response body",
    "stream disconnected before completion",
    "ECONNRESET"
  ]
}
```

### Config fields

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Enables or disables the extension logic. |
| `retryMessage` | `string` | The exact user message sent back to pi after a matched error. |
| `maxConsecutiveAutoRetries` | `number` | Maximum automatic retries before the extension stops retrying. |
| `notifyOnAutoContinue` | `boolean` | Shows a UI notification when an automatic retry happens or when the retry limit is reached. |
| `errorPatterns` | `string[]` | Case-insensitive substrings used to detect transient failures. |

## Development

Install dependencies:

```bash
npm install
```

Run the type check:

```bash
npm run check
```

Preview the npm package contents:

```bash
npm run pack:check
```

## Package structure

```text
.
├── config.json
├── index.ts
├── LICENSE
├── package.json
├── README.md
└── tsconfig.json
```

## Updating

Reinstall the package from npm:

```bash
pi install npm:pi-hodor
```

Or update from git:

```bash
pi install git:github.com/vurihuang/pi-hodor
```

Restart pi after updating.

## Publish to npm

1. Make sure the `pi-hodor` package name is available on npm.

2. Log in to npm:

   ```bash
   npm login
   ```

3. Optionally bump the version:

   ```bash
   npm version patch
   ```

4. Verify the package contents:

   ```bash
   npm pack --dry-run
   ```

5. Publish the package:

   ```bash
   npm publish
   ```

## Install as a pi package

This project is already structured as a pi package via the `pi` field in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

That means pi can install it from a local path, npm, or git using the standard pi package flow.
