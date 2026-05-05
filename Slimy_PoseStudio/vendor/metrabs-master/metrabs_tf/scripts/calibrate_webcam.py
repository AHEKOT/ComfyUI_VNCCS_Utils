import glob

import cv2
import numpy as np


def main():
    checkerboard_size = (6, 8)
    image_paths = glob.glob('checkerboard_images/*.jpg')

    points3d = []
    points2d = []

    # World coordinates for 3D points
    objp = np.zeros((1, checkerboard_size[0] * checkerboard_size[1], 3), np.float32)
    objp[0, :, :2] = np.mgrid[0:checkerboard_size[0], 0:checkerboard_size[1]].T.reshape(-1, 2)

    for image_path in image_paths:
        im_color = cv2.imread(image_path)
        im_gray = cv2.cvtColor(im_color, cv2.COLOR_BGR2GRAY)
        success, corners = cv2.findChessboardCorners(
            im_gray, checkerboard_size,
            cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_FAST_CHECK | cv2.CALIB_CB_NORMALIZE_IMAGE)

        if success:
            points3d.append(objp)
            # Refine pixel coordinates
            corners_refined = cv2.cornerSubPix(
                im_gray, corners, (11, 11), (-1, -1),
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001))
            points2d.append(corners_refined)

            # Draw and display corners
            im_color = cv2.drawChessboardCorners(
                im_color, checkerboard_size, corners_refined, success)

        cv2.imshow('img', im_color)
        cv2.waitKey(0)

    cv2.destroyAllWindows()

    success, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(
        points3d, points2d, im_gray.shape[::-1], None, None)

    print("Camera matrix : \n")
    print(mtx)
    print("\ndist : \n")
    print(dist)
    print("\nrvecs : \n")
    print(rvecs)
    print("\ntvecs : \n")
    print(tvecs)


if __name__ == '__main__':
    main()
