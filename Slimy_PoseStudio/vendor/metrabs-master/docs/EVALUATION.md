
# Evaluation

To compute benchmark evaluation metrics, we first need to produce predictions on test data,
 then we run the evaluation script on the prediction results.
 For example:

```bash
$ CHECKPOINT_DIR="$DATA_ROOT/experiments/h36m/someconfig"
$ ./main.py --test --dataset=h36m --stride-test=4 --checkpoint-dir="$CHECKPOINT_DIR"
$ python -m scripts.eval_h36m --pred-path="$CHECKPOINT_DIR/predictions_h36m.npz"
```

```bash
$ CHECKPOINT_DIR="$DATA_ROOT/experiments/3dhp/someconfig"
$ ./main.py --test --dataset=mpi-inf-3dhp --stride-test=4 --checkpoint-dir="$CHECKPOINT_DIR"
$ python -m scripts.eval_3dhp --pred-path="$CHECKPOINT_DIR/predictions_mpi-inf-3dhp.npz"
```

```bash
$ CHECKPOINT_DIR="$DATA_ROOT/experiments/muco/someconfig"
$ ./main.py --test --dataset=mupots --scale-recovery=metrabs --stride-test=32 --checkpoint-dir="$CHECKPOINT_DIR"
$ python -m scripts.eval_mupots --pred-path="$CHECKPOINT_DIR/predictions_mupots.npz"
```

The first command in each case creates the file `$CHECKPOINT_DIR/${DATASET}_pred.npz`.

Note: the script `eval_mupots.py` was designed and tested to produce the same results as Mehta et al.'s official MuPoTS Matlab evaluation script. 
 However, this Python version is much faster and computes several variations of the evaluation metrics at the same time 
 (only matched or all annotations, root relative or absolute, universal or metric-scale, bone rescaling, number of joints).

To evaluate and average over multiple random seeds:

```bash
$ for s in {1..5}; do ./main.py --train --test --dataset=h36m --train-on=trainval --epochs=27 --seed=$i --logdir=h36m/metro_seed$i; done
$ python -m scripts.eval_h36m --pred-path="h36m/metro_seed1/predictions_h36m.npz" --seeds=5
```
