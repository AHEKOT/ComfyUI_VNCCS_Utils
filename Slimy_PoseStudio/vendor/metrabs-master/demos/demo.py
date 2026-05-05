import tensorflow as tf
import tensorflow_hub as tfhub


def main():
    model = tfhub.load('https://bit.ly/metrabs_l')
    image = tf.image.decode_jpeg(tf.io.read_file('../test_image_3dpw.jpg'))
    skeleton = 'smpl_24'

    # Predict
    pred = model.detect_poses(image, default_fov_degrees=55, skeleton=skeleton)

    # Convert result to numpy arrays
    pred = tf.nest.map_structure(lambda x: x.numpy(), pred)

    # Visualize
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()
    visualize(image.numpy(), pred, joint_names, joint_edges)

    # Read the docs to learn how to
    # - supply your own bounding boxes
    # - perform multi-image (batched) prediction
    # - supply the intrinsic matrix
    # - select the skeleton convention (COCO, H36M, SMPL...)
    # etc.


def visualize(image, pred, joint_names, joint_edges):
    try:
        visualize_poseviz(image, pred, joint_names, joint_edges)
    except ImportError:
        print(
            'Install PoseViz from https://github.com/isarandi/poseviz to get a nicer 3D'
            'visualization.')
        visualize_matplotlib(image, pred, joint_names, joint_edges)


def visualize_poseviz(image, pred, joint_names, joint_edges):
    # Install PoseViz from https://github.com/isarandi/poseviz
    import poseviz
    import cameralib
    camera = cameralib.Camera.from_fov(55, image.shape)
    viz = poseviz.PoseViz(joint_names, joint_edges)
    viz.update(frame=image, boxes=pred['boxes'], poses=pred['poses3d'], camera=camera)


def visualize_matplotlib(image, pred, joint_names, joint_edges):
    detections, poses3d, poses2d = pred['boxes'], pred['poses3d'], pred['poses2d']

    import matplotlib.pyplot as plt
    # noinspection PyUnresolvedReferences
    from mpl_toolkits.mplot3d import Axes3D
    from matplotlib.patches import Rectangle
    plt.switch_backend('TkAgg')

    fig = plt.figure(figsize=(10, 5.2))
    image_ax = fig.add_subplot(1, 2, 1)
    image_ax.imshow(image)
    for x, y, w, h in detections[:, :4]:
        image_ax.add_patch(Rectangle((x, y), w, h, fill=False))

    pose_ax = fig.add_subplot(1, 2, 2, projection='3d')
    pose_ax.view_init(5, -85)
    pose_ax.set_xlim3d(-1500, 1500)
    pose_ax.set_zlim3d(-1500, 1500)
    pose_ax.set_ylim3d(0, 3000)
    pose_ax.set_box_aspect((1, 1, 1))

    # Matplotlib plots the Z axis as vertical, but our poses have Y as the vertical axis.
    # Therefore, we do a 90° rotation around the X axis:
    poses3d[..., 1], poses3d[..., 2] = poses3d[..., 2], -poses3d[..., 1]
    for pose3d, pose2d in zip(poses3d, poses2d):
        for i_start, i_end in joint_edges:
            image_ax.plot(*zip(pose2d[i_start], pose2d[i_end]), marker='o', markersize=2)
            pose_ax.plot(*zip(pose3d[i_start], pose3d[i_end]), marker='o', markersize=2)
        image_ax.scatter(*pose2d.T, s=2)
        pose_ax.scatter(*pose3d.T, s=2)

    fig.tight_layout()
    plt.show()


if __name__ == '__main__':
    main()
