**Note: You don't need to do this if you simply want to run inference. See the 'Inference' section in the main README.md.**

# Dataset Preparation
To run the experiments (or similar ones) as described in the paper, you need to download and prepare the datasets.

**Warning:** Completing *all* the downloads and *all* the preprocessing for the 32 datasets will take very long and you will need a small GPU cluster and a few terabytes of storage.
If you just want to train on Human3.6M or MPI-INF-3DHP, preprocessing will take substantially less time.

While these scripts try to be helpful, they aren't bulletproof production-grade software. Don't blame me if it formats your hard drives / blows up your computer / eats your lunch / etc.!
 
**Disclaimer:** These are third party datasets, so make sure you understand the licenses involved 
and cite the appropriate papers when using them. 
I don't host the datasets, I merely wrote these scripts to help with downloading them. 
Contact the creators directly for questions about the datasets themselves.

## How it works

The preprocessing code is located in two places in this codebase (this could be refactored later). One place is the `dataset_preparation` directory, where you find individual Bash scripts for each dataset that contain initial preprocessing steps,
such as downloading and extracting the data, perhaps some image conversions, running a person detector and a person segmentation model etc. 
Another part of the preprocessing code is in the `src/data` directory, as Python files.

You need to set the `$DATA_ROOT` environment variable to where you want to place the datasets. If you don't have enough space on one disk, use symlinks inside `$DATA_ROOT`.
There will be two directories in `$DATA_ROOT`: one for the main dataset files, called e.g. `h36m` for Human3.6M, and one containing downscaled images for faster loading, e.g. `h36m_downscaled`. 

At the end, for each dataset, there will also be a pickled `data.datasets3d.Pose3DDataset` object saved to disk in the `$CACHE_DIR`, named something like `h36m.pkl`.
These dataset objects contain a list of `data.datasets3d.Pose3DExample` objects, which contain a string path (pointing to a downscaled/cropped image),
a foreground segmentation mask (for background augmentation), a person bounding box, the 3D pose keypoints and camera parameters, in the form of a `cameralib.Camera` object.
The `data.datasets3d.Pose3DDataset` object also has a `JointInfo` object storing information about the joint names and edges of the skeleton format employed by the dataset.

## Merging

For the multi-dataset merging (i.e. combining the 28 datasets into one meta-dataset), the code can be found in `data.merging.merged_dataset`.
This merging code is unfortunately not very memory-efficient (the code started out with much fewer datasets at first), so in its current form, it needs several hundreds of gigabytes of RAM for loading all the 
individual datasets to RAM, then expand the 3D keypoint arrays to a larger representation (e.g. 555 joints, the union of all joints). It also needs a few hours to complete this merging process and save the final pickle file that contains the meta-dataset.
The main merged dataset is called `huge8`, the medium-sized one is called `medium3`, the small one is `small5`. The numbers 8, 3, 5 are not significant, they are internal versioning numbers, which I kept for consistency.
