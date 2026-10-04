"""Text-to-motion for Pose Studio.

Every motion model is described by one JSON file in ``config/motion_models`` (where
its code and weights come from, what it can do, its license) and implemented by a
``MotionBackend`` subclass registered in ``registry.BACKENDS``. Backends return a
``SourceMotion`` in their own skeleton; the shared code in ``transform`` places it
on the mannequin, so a new model only has to describe its joints.
"""
