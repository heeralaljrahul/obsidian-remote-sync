# Third-party notices

`main.js` (the file BRAT installs) bundles the following open-source software. Their license headers are also kept inside `main.js`.

| Component | Version | License | Copyright |
|---|---|---|---|
| [localForage](https://github.com/localForage/localForage) | 1.10.0 | Apache-2.0 | © 2013-2017 Mozilla |
| [lie](https://github.com/calvinmetcalf/lie) (bundled inside localForage) | 3.1.1 | MIT | © Calvin Metcalf |
| [immediate](https://github.com/calvinmetcalf/immediate) (bundled inside localForage) | 3.0.x | MIT | © Calvin Metcalf, Domenic Denicola, Brian Cavalier |
| [spark-md5](https://github.com/satazor/js-spark-md5) | 3.0.2 | MIT (or WTFPL) | © André Cruz |

The plugin also runs against the [Obsidian](https://obsidian.md) plugin API (`obsidian` package, provided by the Obsidian app at runtime, not bundled) and calls the [Google Drive API v3](https://developers.google.com/drive/api) and Google OAuth 2.0 endpoints.

Development-only tools (not shipped in `main.js`): TypeScript, esbuild, tsx, Mocha, Chai, Playwright, ESLint, typescript-eslint, Prettier. Each is used under its own license (MIT or Apache-2.0).

## Apache License 2.0 (localForage)

See [LICENSE](LICENSE) in this repository (the same license text).

## MIT License (lie, immediate, spark-md5)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
