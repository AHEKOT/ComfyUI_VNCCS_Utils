import cameralib
import numpy as np
import poseviz
import tensorflow_hub as tfhub


class VizModel:
    def __init__(self, model_path_or_url, skeleton, default_fov=55):
        self.model = tfhub.load(model_path_or_url)
        self.skeleton = skeleton
        joint_names = self.model.per_skeleton_joint_names[skeleton].numpy().astype(str)
        joint_edges = self.model.per_skeleton_joint_edges[skeleton].numpy()
        self.viz = poseviz.PoseViz(joint_names, joint_edges)
        self.default_fov = default_fov

    def detect_and_visualize_poses_batched(self, frame_batch_gpu, frame_batch_cpu, cameras=None):
        if cameras is None:
            cameras = cameralib.Camera.from_fov(55, imshape=frame_batch_gpu.shape[1:3])

        if not isinstance(cameras, (list, tuple)):
            cameras = [cameras] * frame_batch_gpu.shape[0]

        intrinsics = np.stack([c.intrinsic_matrix for c in cameras])
        extrinsics = np.stack([c.get_extrinsic_matrix() for c in cameras])

        pred = self.model.detect_poses_batched(
            frame_batch_gpu, intrinsic_matrix=intrinsics, extrinsic_matrix=extrinsics,
            world_up_vector=cameras[0].world_up, skeleton=self.skeleton)

        for frame, boxes, poses, camera in zip(
                frame_batch_cpu, pred['boxes'], pred['poses3d'], cameras):
            self.viz.update(frame=frame, boxes=boxes, poses=poses, camera=camera)
