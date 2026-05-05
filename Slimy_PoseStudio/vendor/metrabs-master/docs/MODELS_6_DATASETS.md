# Model Downloads

Note: these models **cannot be used for commercial purposes** due to the license terms of the training data (see below).

| Model Download                                                                                                          | Backbone          | Detector    | 3DPW PCK@50mm ↑ | 3DPW MPJPE ↓ | H36M S9/S11 MPJPE ↓ | 3DHP PCK@150mm ↑ | MuPoTS PCK@150mm ↑ | MuPoTS APCK@150mm ↑| Avg FPS on 3DPW (batched) ↑ | Single-person FPS (batched) ↑ |
|-------------------------------------------------------------------------------------------------------------------------|-------------------|-------------|-----------------|--------------|---------------------|------------------|--------------------|--------------------|---------------------------|-----------------------------|
| [metrabs_eff2l_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_eff2l_y4.zip)                   | EfficientNetV2-L  | YOLOv4      | 53.3%       | 61.9 mm  | 41.1 mm         | 95.7%        | 90.6               | 42.5               |                           |                             |
| [metrabs_eff2m_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_eff2m_y4.zip)                   | EfficientNetV2-M  | YOLOv4      | 52.7%           | 62.7 mm      | 43.4 mm             | 94.9%            | 90.4               | 38.7               |                           |                             |
| [metrabs_eff2s_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_eff2s_y4.zip)                   | EfficientNetV2-S  | YOLOv4      | 50.8%           | 64.9 mm      | 47.4 mm             | 94.5%            | 90.0               | 43.6               |                           |                             |
| [metrabs_rn152_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_rn152_y4.zip)                   | ResNet-152        | YOLOv4      | 51.2%           | 63.5 mm      | 46.2 mm             | 93.6%            | 89.5               | 41.0               |                           |                             |
| [metrabs_rn101_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_rn101_y4.zip)                   | ResNet-101        | YOLOv4      | 51.3%           | 64.2 mm      | 47.6 mm             | 93.4%            | 89.6               | 43.5               |                           |                             |
| [metrabs_rn50_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_rn50_y4.zip)                     | ResNet-50         | YOLOv4      | 49.4%           | 66.5 mm      | 48.7 mm             | 92.7%            | 88.6               | 42.6               |                           |                             |
| [metrabs_rn34_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_rn34_y4.zip)                     | ResNet-34         | YOLOv4      | 49.9%           | 65.9 mm      | 47.3 mm             | 92.4%            | 88.7               | 42.3               |                           |                             |
| [metrabs_rn18_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_rn18_y4.zip)                     | ResNet-18         | YOLOv4      | 46.3%           | 70.8 mm      | 52.5 mm             | 90.1%            | 87.0               | 42.6               |                           |                             |
| [metrabs_mob3l_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_mob3l_y4.zip)                   | MobileNetV3-L     | YOLOv4      | 44.6%           | 73.1 mm      | 53.9 mm             | 89.7%            | 86.6               | 36.3               |                           |                             |
| [metrabs_mob3s_y4](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_mob3s_y4.zip)                   | MobileNetV3-S     | YOLOv4      | 36.5%           | 86.4 mm      | 68.3 mm             | 82.4%            | 81.8               | 34.8               |                           |                             |
| [metrabs_mob3l_y4t](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_mob3l_y4t.zip)                 | MobileNetV3-L     | YOLOv4-tiny | 44.3%           | 74.1 mm      | 54.0 mm             | 89.5%            | 81.0               | 35.8               |                           |                             |
| [metrabs_mob3s_y4t](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_mob3s_y4t.zip)                 | MobileNetV3-S     | YOLOv4-tiny | 36.3%           | 87.3 mm      | 68.3 mm             | 82.0%            | 76.8               | 33.3               |                           |                             |
| [metrabs_eff2l_y4_360](https://omnomnom.vision.rwth-aachen.de/data/metrabs/metrabs_eff2l_y4_360.zip)*          | EfficientNetV2-L  | YOLOv4      | 48.7%           | 66.1 mm      | 47.5 mm             | 95.0%            | 90.1               | 42.7               |                           |                             |

*metrabs_eff2l_y4_360 was trained with 360° rotation augmentation, resulting in an approximately rotation-invariant model that qualitatively handles extreme poses (e.g., yoga, cartwheel) more robustly.  

This evaluation was performed with the built-in 5-crop test-time augmentation. More detailed evaluation results    .

## Training Datasets

- [Human3.6M](http://vision.imar.ro/human3.6m)
- [MuCo-3DHP](https://vcai.mpi-inf.mpg.de/projects/SingleShotMultiPerson/)
- [CMU-Panoptic](http://domedb.perception.cs.cmu.edu/)
- [SAIL-VOS](http://sailvos.web.illinois.edu/_site/index.html)
- [SURREAL](https://www.di.ens.fr/willow/research/surreal/data/)
- [AIST-Dance++](https://google.github.io/aistplusplus_dataset/index.html)
- [COCO (2D pose)](https://cocodataset.org/)
