# Training

Make sure to install the dependencies (see [install_dependencies.sh](../install_dependencies.sh)) and [prepare the datasets](DATASETS.md)
 first (mind the licenses, some/most data is restricted to academic research), then you can train the models. Here are a few example configurations

It's a good idea to enable XLA by setting the environment variable `TF_XLA_FLAGS=--tf_xla_auto_jit=2`, this can result in quite some speedup depending on hardware.

## Step 1) Train Initial Model

For example, let us consider an EfficientNetV2-L backbone

```bash
export TF_XLA_FLAGS=--tf_xla_auto_jit=2
python -m main --train --logdir effv2l_28ds_256_sep --backbone=efficientnetv2-l --dataset=huge8 --dataset2d=huge2d_common --training-steps=400000 --validate-period=2000 --finetune-in-inference-mode=1000 --ghost-bn=16,16,16,16,16,16,16,16 
```

Fine-tuning will need an exported SavedModel to use as pretrained initialization. (Technical detail: Saving and loading these can be tricky in Keras/TF due to various mismatches, but what works is to export the model to a SavedModel in float32 mode and to load it back in float16 for finetuning. Otherwise, the mixed precision policy has issues.)

We export the pretrained backbone to a SavedModel in float32. Also, we need to use the checkpoint from before the final inference mode fine-tuning was turned on.  

```bash
python -m main --export-file=model_nofine_float32 --logdir effv2l_28ds_256_sep --dataset=huge8 --dataset2d=huge2d_common --backbone=efficientnetv2-l --load-path=ckpt-399001 --dtype=float32
```

## Step 2) Train Autoencoder on Pseudo-Ground Truth from Initial Model

### Generate Pseudo-Ground Truth
Now we run inference on Human3.6M and BML-MoVi using the model from Step 1. The result is saved under the experiment's log directory.

```bash
bash scripts/predict_for_autoencoder.sh effv2l_28ds_256_sep efficientnetv2-l huge8
```

### Train Autoencoder

See https://github.com/isarandi/affine-combining-autoencoder

## Step 3) Fine-Tune to Improve Consistency

### Option a) Output regularization

```bash
python -m main --train --logdir effv2l_28ds_256_finetune_regul --regularize-to-manifold --backbone=efficientnetv2-l --dataset=huge8 --dataset2d=huge2d_common --training-steps=40000 --validate-period=500 --finetune-in-inference-mode=1000 --ghost-bn=16,16,16,16,16,16,16,16 --affine-weights=huge8_48_effv2l_6e-1_chir --load-backbone-from="$DATA_ROOT/experiments/effv2l_28ds_256_sep/model_nofine_fp32" --dual-finetune-lr
```

### Option b) Direct latent prediction

```bash
python -m main --train --logdir effv2l_28ds_256_finetune_directlatent --transform-coords --backbone=efficientnetv2-l --dataset=huge8 --dataset2d=huge2d_common --training-steps=40000 --validate-period=500 --finetune-in-inference-mode=1000 --ghost-bn=16,16,16,16,16,16,16,16 --affine-weights=huge8_48_effv2l_6e-1_chir --load-backbone-from="$DATA_ROOT/experiments/effv2l_28ds_256_sep/model_nofine_fp32" --dual-finetune-lr
```

### Option c) Hybrid

```bash
python -m main --train --logdir effv2l_28ds_256_finetune_hybrid --predict-all-and-latents --backbone=efficientnetv2-l --dataset=huge8 --dataset2d=huge2d_common --training-steps=40000 --validate-period=500 --finetune-in-inference-mode=1000 --ghost-bn=16,16,16,16,16,16,16,16 --affine-weights=huge8_48_effv2l_6e-1_chir --load-backbone-from="$DATA_ROOT/experiments/effv2l_28ds_256_sep/model_nofine_fp32" --dual-finetune-lr
```

# Packaging Models

We can package a multi-person-aware SavedModel like this:

```bash
model_dir=$DATA_ROOT/experiments/effv2l_28ds_256_finetune_regul
detector=https://github.com/isarandi/tensorflow-yolov4-tflite/releases/download/v0.1.0/yolov4_416.tar.gz
python -m save_multiperson_model --input-model-path="$model_dir/model" --output-model-path="$model_dir/model_multi" --detector-path="$detector" --bone-length-file="$DATA_ROOT/cache/huge8_bone_lengths.pkl" --skeleton-types-file="$DATA_ROOT/skeleton_conversion/skeleton_types_huge8_with_kinect.pkl" --joint-transform-file="$DATA_ROOT/skeleton_conversion/huge8_48_effv2l_6e-1_chirnozero_to_all_and_kinect.npy

scripts/package_model.sh "$model_dir"
```

