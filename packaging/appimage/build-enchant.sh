#!/usr/bin/env bash
# Builds the spelling library bundled in the Linux AppImage.
#
# Ubuntu's libenchant loads its spelling providers only from the fixed path
# /usr/lib/x86_64-linux-gnu/enchant-2 and the AppImage ships none, so outside
# Debian/Ubuntu nothing was underlined. A relocatable build instead looks for
# providers beside itself ($APPDIR/usr/lib/enchant-2) and dictionaries in
# $XDG_DATA_DIRS/hunspell, which the AppImage sets to include /usr/share.
#
# Run on the AppImage build machine (Ubuntu 22.04) with libglib2.0-dev,
# libhunspell-dev and patchelf installed. Usage: build-enchant.sh <stage-dir>
set -euo pipefail

version=2.3.2 # Ubuntu 22.04's version, so the API WebKitGTK was built against
sha256=ce9ba47fd4d34031bd69445598a698a6611602b2b0e91d705e91a6f5099ead6e
stage=$(realpath -m "${1:?usage: build-enchant.sh <stage-dir>}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/enchant.tar.gz" \
  "https://github.com/rrthomas/enchant/releases/download/v$version/enchant-$version.tar.gz"
echo "$sha256  $work/enchant.tar.gz" | sha256sum -c -
tar -xzf "$work/enchant.tar.gz" -C "$work"
cd "$work/enchant-$version"

# libdir must be usr/lib, where the AppImage keeps libraries: relocation
# derives the prefix by removing this libdir from the library's actual folder.
./configure --prefix=/usr --libdir=/usr/lib --enable-relocatable \
  --disable-static --with-hunspell --without-aspell --without-hspell \
  --without-nuspell --without-voikko --without-zemberek --without-applespell
make -j"$(nproc)"
make install DESTDIR="$stage"

lib="$stage/usr/lib"
cp -L "$(pkg-config --variable=libdir hunspell)/libhunspell-1.7.so.0" "$lib/"
# The provider is loaded with dlopen, so it must find libhunspell itself.
patchelf --set-rpath '$ORIGIN/..' "$lib/enchant-2/enchant_hunspell.so"
rm -f "$lib"/*.la "$lib"/enchant-2/*.la
