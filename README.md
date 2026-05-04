# adocserver

Zero-config AsciiDoc documentation server with live reload and sidebar navigation.

## Usage

```bash
npx adocserver ./docs
```

See **[docs/index.adoc](docs/index.adoc)** for full documentation.

## Quick reference

| Command | Description |
|---|---|
| `adocserver ./docs` | Serve docs from `./docs` |
| `adocserver ./docs --port 4000 --open` | Custom port, open browser |
| `adocserver ./docs --host localhost` | Restrict to localhost |

## PDF export

```bash
asciidoctor-pdf -r asciidoctor-mathematical -a mathematical-format=svg docs/index.adoc
```

Requires the `asciidoctor-pdf` and `asciidoctor-mathematical` Ruby gems.
