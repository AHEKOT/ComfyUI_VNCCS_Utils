# MeTRAbs Absolute 3D Human Pose Estimator

<a href="https://colab.research.google.com/github/isarandi/metrabs/blob/master/metrabs_demo.ipynb" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a><br>
[![PWC](https://img.shields.io/endpoint.svg?url=https://paperswithcode.com/badge/metrabs-metric-scale-truncation-robust/3d-human-pose-estimation-on-3d-poses-in-the)](https://paperswithcode.com/sota/3d-human-pose-estimation-on-3d-poses-in-the?p=metrabs-metric-scale-truncation-robust)

<p align="center"><img src=img/demo.gif width="60%"></p>
<p align="center"><a href="https://youtu.be/4VFKiiW9RCQ"><img src=img/thumbnail_video_qual.png width="30%"></a>
<a href="https://youtu.be/BemM8-Lx47g"><img src=img/thumbnail_video_conf.png width="30%"></a></p>

This repository contains code for the following paper:

**[MeTRAbs: Metric-Scale Truncation-Robust Heatmaps for Absolute 3D Human Pose Estimation](https://arxiv.org/abs/2007.07227)** <br>
*by István Sárándi, Timm Linder, Kai O. Arras, Bastian Leibe*<br>
IEEE Transactions on Biometrics, Behavior, and Identity Science (T-BIOM), Selected Best Works From
Automated Face and Gesture Recognition 2020.

The repo has been updated to an improved version employed in the following paper: 

**[Learning 3D Human Pose Estimation from Dozens of Datasets using a Geometry-Aware Autoencoder to Bridge Between Skeleton Formats ](https://arxiv.org/abs/2212.14474)** <br>
*by István Sárándi, Alexander Hermans, Bastian Leibe*<br>
IEEE/CVF Winter Conference on Applications of Computer Vision (WACV), 2023.


## News

* [2023-08-02] Major codebase refactoring, models as described in our [WACV'23 paper](https://istvansarandi.com/dozens), several components factored out into separate repos, PyTorch support for inference, and more.
* [2021-12-03] Added new backbones, including the ResNet family from ResNet-18 to ResNet-152
* [2021-10-19] Released new best-performing [models](docs/MODELS.md) based on EfficientNetV2 and super fast
  ones using MobileNetV3, simplified [API](docs/API.md), multiple skeleton conventions, support for
  radial/tangential distortion, improved antialiasing, plausibility filtering and other new
  features.
* [2021-10-19] Full codebase migrated to TensorFlow 2 and Keras
* [2020-11-19] Oral presentation at the IEEE Conference on Automatic Face and Gesture Recognition
  (FG'20) ([Talk Video](https://youtu.be/BemM8-Lx47g)
  and [Slides](https://vision.rwth-aachen.de/media/papers/203/slides_metrabs.pdf))
* [2020-11-16] Training and evaluation code now released along with dataset pre-processing scripts!
  Code and models upgraded to Tensorflow 2.
* [2020-10-06] [Journal paper](https://arxiv.org/abs/2007.07227) accepted for publication in the
  IEEE Transactions on Biometrics, Behavior, and Identity Science (T-BIOM), Best of FG Special Issue
* [2020-08-23] Short presentation at ECCV2020's 3DPW
  workshop ([slides](https://vision.rwth-aachen.de/media/papers/203/metrabs_3dpw_slides.pdf))
* [2020-08-06] Our method has won
  the **[3DPW Challenge](https://virtualhumans.mpi-inf.mpg.de/3DPW_Challenge/)**

## Inference Code

We release **standalone TensorFlow models** (SavedModel) to allow easy application in downstream
research. After loading the model, you can run inference in a single line of Python **without having
this codebase as a dependency**. Try it in action in
[Google Colab](
https://colab.research.google.com/github/isarandi/metrabs/blob/master/metrabs_demo.ipynb).

### Gist of Usage

```python
import tensorflow as tf
import tensorflow_hub as tfhub

model = tfhub.load('https://bit.ly/metrabs_l')
image = tf.image.decode_jpeg(tf.io.read_file('img/test_image_3dpw.jpg'))
pred = model.detect_poses(image)
pred['boxes'], pred['poses2d'], pred['poses3d']
```

See also the [demos](demos/) folder for more examples.

NOTE: The models can only be used for **non-commercial** purposes due to the licensing of the used
training datasets.

Alternatively, you can try the experimental PyTorch version:

```bash
wget -O - https://bit.ly/metrabs_l_pt | tar -xzvf -
python -m metrabs_pytorch.scripts.demo_image --model-dir metrabs_eff2l_384px_800k_28ds_pytorch --image img/test_image_3dpw.jpg
```

### Demos

* [```./demo.py```](demos/demo.py) to auto-download the model, predict on a sample image and display the
  result with Matplotlib or [PoseViz](https://github.com/isarandi/poseviz) (if installed).
* [```./demo_video.py```](demos/demo_video.py)``` filepath-or-url-to-video.mp4``` to run inference on a video.

### Documentation

- **[How-to Guide with Examples](docs/INFERENCE_GUIDE.md)**
- **[Full API Reference](docs/API.md)**

### Feature Summary

- **Several skeleton conventions** supported through the keyword argument ```skeleton``` (e.g. COCO,
  SMPL, H36M)
- **Multi-image (batched) and single-image** predictions both supported
- **Advanced, parallelized cropping** logic behind the scenes
    - Anti-aliasing through image pyramid and
      supersampling, [gamma-correct rescaling](http://www.ericbrasseur.org/gamma.html).
    - GPU-accelerated undistortion of pinhole perspective (homography) and radial/tangential lens
      distortions
- Estimates returned  in **3D world space** (when calibration is provided) and **2D pixel space**
- Built-in, configurable **test-time augmentation** (TTA) with rotation, flip and brightness (keyword
  argument ```num_aug``` sets the number of TTA crops per detection)
- Automatic **suppression of implausible poses** and non-max suppression on the 3D pose level (can be turned off)
- **Multiple backbones** with different speed-accuracy trade-off (EfficientNetV2, MobileNetV3)

## Training and Evaluation

See the docs directory.

## BibTeX

If you find this work useful in your research, please cite it as:

```bibtex
@article{sarandi2021metrabs,
  title={{MeTRAbs:} Metric-Scale Truncation-Robust Heatmaps for Absolute 3{D} Human Pose Estimation},
  author={S\'ar\'andi, Istv\'an and Linder, Timm and Arras, Kai O. and Leibe, Bastian},
  journal={IEEE Transactions on Biometrics, Behavior, and Identity Science},
  year={2021},
  volume={3},
  number={1},
  pages={16-30},
  doi={10.1109/TBIOM.2020.3037257}
}
```

The above paper is an extended journal version of the FG'2020 conference paper:

```bibtex
@inproceedings{Sarandi20FG,
  title={Metric-Scale Truncation-Robust Heatmaps for 3{D} Human Pose Estimation},
  author={S\'ar\'andi, Istv\'an and Linder, Timm and Arras, Kai O. and Leibe, Bastian},
  booktitle={IEEE International Conference on Automatic Face and Gesture Recognition},
  pages={677-684},
  year={2020}
}
```

The newer large-scale models correspond to the WACV'23 paper:

```bibtex
@inproceedings{Sarandi2023dozens,
    author = {S\'ar\'andi, Istv\'an and Hermans, Alexander and Leibe, Bastian},
    title = {Learning {3D} Human Pose Estimation from Dozens of Datasets using a Geometry-Aware Autoencoder to Bridge Between Skeleton Formats},
    booktitle = {IEEE/CVF Winter Conference on Applications of Computer Vision (WACV)},
    year = {2023}
} 
```

## Contact

Code in this repository was written by [István Sárándi](https://isarandi.github.io) (RWTH Aachen
University) unless indicated otherwise.

Got any questions or feedback? Drop a mail to sarandi@vision.rwth-aachen.de!
