#!/usr/bin/env bash
set -euo pipefail

separate_head_model=$1
backbone=$2
joints=$3

# Make predictions with this model on the Human3.6M trainval and test split
for split in test trainval; do
  ./main.py --predict --logdir "$separate_head_model" --dataset=h36m --test-time-mirror-aug --test-on=$split --mean-relative --model-joints="$joints" --output-joints="$joints" --backbone="$backbone" --batch-size-test=150 --pred-path="${separate_head_model}/pred_h36m_${split}_mirror.npz"
done

./main.py --predict --logdir "$separate_head_model" --dataset=bml_movi --test-time-mirror-aug --test-on=trainval --mean-relative --model-joints="$joints" --output-joints="$joints" --backbone="$backbone" --batch-size-test=150 --pred-path="${separate_head_model}/pred_bml_movi_mirror.npz"
