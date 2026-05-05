# MeTRAbs API Reference

*See also the [inference example guide](INFERENCE_GUIDE.md) and [demo.py](../demos/demo.py), [demo_webcam.py](../demo_webcam.py) and [demo_video_batched.py](../demo_video_batched.py)*

All [models are released](MODELS.md) as TensorFlow SavedModels for ease of use and can be loaded as

```python
import tensorflow_hub as hub

model = hub.load(path_or_url)
```

## Methods

### model.detect_poses

Performs person detection, multi-person absolute 3D human pose estimation with test-time
augmentation, output pose plausibility-filtering and non-maximum suppression (optional) on a single
image.

```python
model.detect_poses(
    image, intrinsic_matrix=UNKNOWN,
    distortion_coeffs=(0, 0, 0, 0, 0), extrinsic_matrix=eye(4),
    world_up_vector=(0, -1, 0), default_fov_degrees=55, internal_batch_size=64,
    antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
    detector_nms_iou_threshold=0.7, max_detections=-1, detector_flip_aug=False,
    suppress_implausible_poses=True)
```

#### Arguments:

Only the first argument is mandatory.

- **image**: a ```uint8``` Tensor of shape ```[H, W, 3]``` containing an RGB image.
- **intrinsic_matrix**: a ```float32``` Tensor of shape ```[3, 3]```, the camera's intrinsic matrix.
  If left at the default value, the intrinsic matrix is determined from
  the ```default_fov_degrees``` argument.
- **distortion_coeffs**: a ```float32``` Tensor of a single dimension and between 5 and 12 elements.
  These are the lens distortion coefficients according to OpenCV's distortion model and the same order
  (k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4). If it has less than 12 elements, the rest are
  assumed to be zero.
- **extrinsic_matrix**: a ```float32``` Tensor of shape ```[4, 4]```, the camera extrinsic matrix,
  with millimeters as the unit of the translation vector.
- **world_up_vector**: a ```float32``` Tensor of shape ```[3]``` the vector pointing up in the world
  coordinate system. Used for sending "upright" crops into the pose estimation model, even if the
  camera's roll angle is nonzero.
- **default_fov_degrees**: in case ```intrinsic_matrix``` is not supplied, this float scalar
  specifies the field of view in degrees along the larger side of the input image.
- **internal_batch_size**: integer, the size of the crop batches sent to the raw crop-consuming model
  internally. The image crops are batched up internally, so in case of many detections, they are
  processed in chunks to avoid running out of GPU memory. The appropriate value depends on available
  GPU memory and the size of the backbone.
- **antialias_factor**: integer, supersampling factor to avoid aliasing effects, e.g. if set to 2,
  then we first internally generate 512x512 px crops and shrink the result to 256x256 for
  prediction.
- **num_aug**: the number of test-time augmentations to perform for each person instance.
  Differently rotated, flipped and brightness-adjusted versions of each crop are fed through the
  crop model and results are averaged after transforming back to the camera reference frame.
- **average_aug**: boolean, whether the output should contain averages over the different test-time
  augmentation results. If False, the results will contain all augmentation results individually.
- **skeleton**: string, specifying what skeleton convention to use. See at the end of the page for
  the available options.
- **detector_threshold**: float value for thresholding the inner person detector
- **detector_nms_iou_threshold**: float value for use in non-max suppression inside the detector.
  Too low values may suppress poses that are close to others in the image, while too high values may
  result in duplicates (less likely to be a problem when
  setting ```suppress_implausible_poses=True```).
- **max_detections**: integer, limits the number of detections to the
  best-scoring ```max_detections```. This can speed up prediction, since only a reduced number of
  detections are sent to the pose estimator. Set to -1 to use all detections.
- **detector_flip_aug**: boolean specifying whether to run the image through the detector with
  horizontal flipping as well and aggregate the results (before the detector NMS step).
- **suppress_implausible_poses**: bool, specifying whether to suppress (i.e. filter out from the
  result) poses with implausible bone lengths, inconsistent test-time augmentation results and to
  perform non-maximum suppresson on the pose level (this is in addition to the detector-level NMS).

#### Return value:

A dictionary with the following three keys and corresponding tensor values:

- **boxes**: ```[left, top, width, height, confidence]``` for each detection box. Shape
  is ```[num_detections, 5]```.
- **poses3d**: The 3D poses corresponding to the detected people. Each pose is
  shaped ```[num_joints, 3]``` and is given in the 3D world coordinate system in millimeters (or in
  the camera coordinate frame, if ```extrinsic_matrix``` is not specified). The number of joints
  depends on the selected ```skeleton``` as input argument. Shape
  is ```[num_detections, num_joints, 3]``` if ```average_aug``` is True,
  else ```[num_detections, num_aug, num_joints, 3]```.
- **poses2d**: Like ```poses3d```, except in 2D pixel coordinates (addressing the input image's
  pixel space) so it has shape ```[num_detections, num_joints, 2]``` if ```average_aug``` is True,
  else ```[num_detections, num_aug, num_joints, 2]```.

### model.detect_poses_batched

The batched (multiple input images) equivalent of ```detect_poses```. Performs person detection,
multi-person absolute 3D human pose estimation with test-time augmentation, output pose
plausibility-filtering and non-maximum suppression (optional) on a batch of images.

```python
model.detect_poses_batched(
    images, intrinsic_matrix=(UNKNOWN,),
    distortion_coeffs=((0, 0, 0, 0, 0),), extrinsic_matrix=(eye(4),),
    world_up_vector=(0, -1, 0), default_fov_degrees=55, internal_batch_size=64,
    antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
    detector_nms_iou_threshold=0.7, max_detections=-1, detector_flip_aug=False,
    suppress_implausible_poses=True)
```

Only the first argument is mandatory.

- **images**: a batch of RGB images as a ```uint8``` Tensor with shape ```[N, H, W, 3]```
- **intrinsic_matrix**: either a ```float32``` Tensor of shape ```[N, 3, 3]``` giving the intrinsic
  matrix for each image, or a ```float32``` Tensor of shape ```[1, 3, 3]``` in which case the same
  intrinsic matrix is used for all the images in the batch. Optional. If not given, the intrinsic
  matrix is determined from the ```default_fov_degrees``` argument.
- **distortion_coeffs**: a ```float32``` Tensor of shape ```[N, M]``` or ```[1, M]```, M lens
  distortion coefficients for each image, according to OpenCV's distortion model and the same
  order (k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4). If M<12, the rest of the coefficients are assumed zero.
  If the first dimension in the shape is 1, the same distortion coefficients are
  applied for all images.
- **extrinsic_matrix**: either a ```float32``` Tensor of shape ```[N, 4, 4]``` giving the extrinsic
  matrix for each image, or a ```float32``` Tensor of shape ```[1, 4, 4]``` in which case the same
  extrinsic matrix is used for all the images in the batch. The unit of the translation vector
  should be millimeters.
- **world_up_vector**: a ```float32``` Tensor of shape ```[3]``` the vector pointing up in the world
  coordinate system. Used for sending "upright" crops into the pose estimation model, even if the
  camera's roll angle is nonzero.
- **The remaining arguments have the same shape and meaning as in ```detect_poses``` (see above).**

#### Return value:

A dictionary with the following keys and values:

- **boxes**: ```[left, top, width, height, confidence]``` for each detection box. It is
  a ```tf.RaggedTensor``` with shape ```[N, None, 5]``` where the None stands for the ragged
  dimension (the image-specific number of detections).
- **poses3d**: The 3D poses corresponding to the detections. Each pose is
  shaped ```[num_joints, 3]``` and is given in the 3D world coordinate system in millimeters (or in
  the camera coordinate system, if the ```extrinsic_matrix``` is not provided). The number of joints
  depends on the selected ```skeleton``` as input argument. Similar to the ```boxes```
  output, ```poses3d``` is a RaggedTensor, but with shape ```[N, None, num_joints, 3]```
  if ```average_aug``` is True, else ```[N, None, num_aug, num_joints, 3]```
- **poses2d**: Similar structure to ```poses3d```, except in 2D pixel coordinates (addressing the
  input image's pixel space) so the last dimension has size 2 instead of 3 (RaggedTensor, with
  shape ```[N, None, num_joints, 2]``` or ```[N, None, num_aug, num_joints, 2]```)

### model.estimate_poses

Multi-person absolute 3D human pose estimation with test-time augmentation on a single image.
As ```detect_poses```, but the bounding boxes are supplied by the user and not the built-in
detector.

```python
model.estimate_poses(
    image, boxes, intrinsic_matrix=UNKNOWN,
    distortion_coeffs=(0, 0, 0, 0, 0), extrinsic_matrix=eye(4),
    world_up_vector=(0, -1, 0), default_fov_degrees=55, internal_batch_size=64,
    antialias_factor=1, num_aug=5, average_aug=True, skeleton='')
```

#### Arguments:

- **image**: a ```uint8``` Tensor of shape ```[H, W, 3]``` containing an RGB image.
- **boxes**: ```[left, top, width, height]``` for each person's bounding box. A Tensor of shape
  ```[num_boxes, 4]``` and type ```tf.float32```.
- **The remaining arguments have the same shape and meaning as in ```detect_poses``` (see above).**
  Note that the arguments of ```detect_poses``` after ```skeleton``` are not applicable to this
  method.

#### Return value:

A dictionary with the following two keys:

- **poses3d**
- **poses2d**

*See ```detect_poses``` above for the documentation of the format of poses3d and poses2d.*

### model.estimate_poses_batched

The batched (multiple input images) equivalent of ```estimate_poses```. Multi-person absolute 3D
human pose estimation with test-time augmentation on multiple images.

```python
model.estimate_poses_batched(
    images, boxes, intrinsic_matrix=(UNKNOWN,), distortion_coeffs=((0, 0, 0, 0, 0),),
    extrinsic_matrix=(eye(4),), world_up_vector=(0, -1, 0), default_fov_degrees=55,
    internal_batch_size=64, antialias_factor=1, num_aug=5, average_aug=True, skeleton='')
```

- **images**: a batch of RGB images as a ```uint8``` Tensor with shape ```[N, H, W, 3]```
- **boxes**: ```[left, top, width, height]``` for each person's bounding box. It needs to be a
  ```tf.RaggedTensor``` with shape ```[N, None, 4]```. An example of creating such a RaggedTensor is
  the following:

```python 
  tf.ragged.constant([
      [
          [im1_box1_x1, im1_box1_y1, im1_box1_width, im1_box1_height], 
          [im1_box2_x1, im1_box2_y1, im1_box2_width, im1_box2_height],
      ],
      [
          [im2_box1_x1, im2_box1_y1, im2_box1_width, im2_box1_height],
          [im2_box2_x1, im2_box2_y1, im2_box2_width, im2_box2_height],
          [im2_box3_x1, im2_box3_y1, im2_box3_width, im2_box3_height],]
      ],
   ragged_rank=1, inner_shape=(4,), dtype=tf.float32)
```

- **The remaining arguments have the same shape and meaning as in ```detect_poses``` (see above).**
  Note that the arguments of ```detect_poses``` after ```skeleton``` are not applicable to this
  method.

#### Return value:

A dictionary with the following keys and values:

- **poses3d**
- **poses2d**

*See ```detect_poses_batched``` above for the documentation of the format of poses3d and poses2d.*

## Attributes

- **per_skeleton_joint_names**: Dictionary that maps from skeleton name (see bottom of page) to a
  Tensor of type ```tf.string```, giving the name of each joint of that skeleton in order.

- **per_skeleton_edges**: Dictionary that maps from skeleton name (see bottom of page)
  to a Tensor of type ```tf.int32```  and shape ```[num_edges, 2]```. It gives the pairs of joint
  indices for each edge in the kinematic tree (aka bones, limbs).

----

# Raw Crop Model

This model requires the user to perform image cropping manually.

It can be accessed as model.crop_model (and extracted to a barebones SavedModel model with tf.saved_mode.save()).

## Methods

### model.predict_multi

```python
model.predict_multi(image, intrinsic_matrix)
```

#### Arguments:

- **image**: a ```float16``` Tensor of shape ```[N, 256, 256, 3]```
- **intrinsic_matrix**: a ```float32``` Tensor of shape ```[N, 3, 3]```

#### Return value:

- **poses3d**: The 3D pose for each crop in the batch, in the 3D camera frame as determined
  by the ```intrinsic_matrix```, in millimeter units. Shaped ```[N, num_joints, 3]```.

----

# Skeleton Conventions

Our models support several different skeleton conventions out of the box. Specify one of the
following strings as the ```skeleton``` argument to the prediction functions.

`smpl_24, kinectv2_25, h36m_17, h36m_25, mpi_inf_3dhp_17, mpi_inf_3dhp_28, coco_19, smplx_42, ghum_35, lsp_14, sailvos_26, gpa_34, aspset_17, bml_movi_87, mads_19, berkeley_mhad_43, total_capture_21, jta_22, ikea_asm_17, human4d_32, 3dpeople_29, umpm_15, smpl+head_30`

To get the names of the joints and kinematic connectivities between them, use
the ```per_skeleton_joint_names``` and ```per_skeleton_edges``` attributes.
