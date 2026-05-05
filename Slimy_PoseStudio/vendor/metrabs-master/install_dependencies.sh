#!/usr/bin/env bash
set -euo pipefail

# This was tested on Ubuntu 18.04 and 22.04
sudo apt update
sudo apt install build-essential --yes wget curl gfortran git ncurses-dev libncursesw5-dev unzip tar libxcb-xinerama0

################
# This part is ONLY needed if you'll work with the original Human3.6M files.
# For this, we need to install the [CDF library](https://cdf.gsfc.nasa.gov/) since the annotations are in CDF files.
# We will use [SpacePy](https://spacepy.github.io/) as a wrapper, which in turn depends on this CDF library.
CDF_VERSION=39_0
wget "https://spdf.gsfc.nasa.gov/pub/software/cdf/dist/cdf${CDF_VERSION}/linux/cdf${CDF_VERSION}-dist-cdf.tar.gz"
tar xf "cdf${CDF_VERSION}-dist-cdf.tar.gz"
rm "cdf${CDF_VERSION}-dist-cdf.tar.gz"
pushd "cdf${CDF_VERSION}-dist"
make OS=linux ENV=gnu CURSES=yes FORTRAN=no UCOPTIONS=-O2 SHARED=yes -j"$(nproc)" all
# If you have sudo rights, simply run `sudo make install`. If you have no `sudo` rights, make sure to add
# `cdf${CDF_VERSION}-dist/src/lib` to the `LD_LIBRARY_PATH` environment variable (add the line below to ~/.bashrc for permanent effect), or use GNU Stow.
# The following will work temporarily:
export LD_LIBRARY_PATH=$PWD/src/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
popd
####################

# Conda is the simplest way to install the dependencies
# If you don't have it yet, install Miniconda as follows:
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash ./Miniconda3-latest-Linux-x86_64.sh -b
eval "$("$HOME/miniconda3/bin/conda" shell.bash hook)"

# Create a new environment and install the dependencies
conda env create --name=metrabs --file=environment.yml
conda activate metrabs
pip install --no-build-isolation git+https://github.com/spacepy/spacepy

# Optional:
# Install libjpeg-turbo for faster JPEG decoding.
# wget https://sourceforge.net/projects/libjpeg-turbo/files/2.0.5/libjpeg-turbo-2.0.5.tar.gz
# Then compile it.
# Or use the repo:
# git clone https://github.com/libjpeg-turbo/libjpeg-turbo.git
# cd libjpeg-turbo
# PACKAGE_NAME=libjpeg-turbo
# TARGET=$HOME/.local
# sudo apt install nasm
# cmake -DCMAKE_INSTALL_PREFIX="$TARGET"  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -G"Unix Makefiles" .
# TEMP_DESTDIR=$(mktemp --directory --tmpdir="$STOW_DIR")
# make -j "$(nproc)" install DESTDIR="$TEMP_DESTDIR"
# mv -T "$TEMP_DESTDIR/$TARGET" "$STOW_DIR/$PACKAGE_NAME"
# rm -rf "$TEMP_DESTDIR"
# stow "$PACKAGE_NAME" --target="$TARGET"
