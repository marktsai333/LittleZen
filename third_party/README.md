# Bundled components

The experimental standalone installer core is built with Python 3.13.17 and PyInstaller 6.16.0. Their license texts are included in `licenses/`. The bundled fx-autoconfig files and their MPL-2.0 license are in `vendor/fx-autoconfig/`; `UPSTREAM` records the pinned revision.

The Python macOS installer used for the packaging experiment was downloaded from python.org. Its SHA-256 was `3053592af66128269efab37fe7851a4894920b27c442aeec99ce4d34d17c07e3`. It was extracted into the ignored build directory for testing, not installed system-wide. Local relocation and ad-hoc signing were used for this experimental build. Distribution signing, notarization, full third-party notice review, and upstream Little Zen licensing still need review before a public installer release.
