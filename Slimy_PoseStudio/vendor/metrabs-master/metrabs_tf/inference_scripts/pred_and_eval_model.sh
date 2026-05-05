#!/usr/bin/env bash
set -euo pipefail

model_name=$1
shift
train_ds=$1
shift
suffix=$1
shift
resolution=$1
shift
model_dir=$DATA_ROOT/experiments/kerasreprod/${model_name}
model_path=$model_dir/model_multi${suffix}
detector_path=https://github.com/isarandi/tensorflow-yolov4-tflite/releases/download/v0.1.0/yolov4_416.tar.gz
bone_length_file="$DATA_ROOT/cache/${train_ds}_bone_lengths.pkl"
skeleton_types_file="$DATA_ROOT/skeleton_conversion/skeleton_types_${train_ds}.pkl"

if [[ ! -d $model_path ]]; then
  raw_model_path=$model_dir/model${suffix}
  python -m save_multiperson_model \
   --crop-side="$resolution" \
   --input-model-path "$raw_model_path" \
   --output-model-path="$model_path" \
   --detector-path="$detector_path" \
   --bone-length-file="$bone_length_file" \
   --skeleton-types-file="$skeleton_types_file"
fi

if [[ -z ${1+x} ]]; then
  datasets="tdpw h36m mupots tdhp"
else
  datasets=$*
fi

for dataset in $datasets; do
  echo $dataset
  if [[ $dataset == 3dpw ]]; then
    extra_args='--real-intrinsics --no-gtassoc'
    suffix_now="${suffix}_realintr_nogtassoc"
    #extra_args='--no-gtassoc'
    #suffix_now="${suffix}_nogtassoc"
  #elif [[ $dataset == h36m ]]; then
  #  extra_args='--num-joints=25'
  #  suffix_now="${suffix}_j25"
  else
    extra_args=''
    suffix_now=${suffix}
  fi

  for num_aug in 1; do # 2 5 15; do
    pred_path=$model_dir/${dataset}_pred${suffix_now}_aug${num_aug}.npz
    if [[ ! -f $pred_path ]]; then
      echo Generating $pred_path
      python -m "inference_scripts.predict_$dataset" \
       --model-path="$model_path" \
       --output-path="$pred_path" \
       --internal-batch-size=16 \
       --num-aug=$num_aug $extra_args #--viz # --out-video-dir=$model_dir/video_preds/${dataset}
    fi
    #if [[ ! -f ${pred_path}_eval2.txt ]]; then
      python -m posepile.ds.$dataset.eval --pred-path="$pred_path" | tee "${pred_path}_eval2.txt"

      echo ----
      echo
    #fi

    if [[ $dataset == 'tdhp' && ! -f "${pred_path}_univ_eval2.txt" ]]; then
        python -m posepile.ds.$dataset.eval --pred-path="$pred_path" --universal-skeleton | tee "${pred_path}_univ_eval2.txt"
    fi

  done
done
