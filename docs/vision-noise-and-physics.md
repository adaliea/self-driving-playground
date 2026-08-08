# Vision pose noise and vehicle physics

This note records the assumptions behind the playground's vehicle-detection noise and whether a general-purpose physics engine would improve the project.

## What real camera perception noise looks like

A camera system does not measure a top-down vehicle box directly. It estimates a 3D center, dimensions, and yaw from pixels, then usually tracks those estimates over time. The resulting errors are not independent, constant white noise:

- **Depth dominates.** Camera-only 3D detection is much less certain along the line of sight than across it. The Waymo LET-3D-AP work explicitly separates lateral and longitudinal error and reports longitudinal error as the prominent term. Its camera-only challenge used a 10% relative-depth tolerance (with a 0.5 m near-range floor), while still penalizing the amount of correction used.
- **Error grows with range.** An object occupies fewer pixels as it recedes, and a fixed image-space error corresponds to a larger metric error. The same Waymo results degrade sharply beyond 50 m and observe approximately range-proportional depth error.
- **Yaw and dimensions are coupled to geometry.** A slightly wrong yaw changes which corners explain the image and can trade off against inferred length, width, and depth. KITTI therefore evaluates bird's-eye-view orientation as well as box overlap.
- **Occlusion causes missing and heavy-tailed results.** KITTI's easy/moderate/hard splits explicitly increase occlusion and truncation while lowering minimum image height. The benchmark notes that some hard labels are not even recognized by humans. A Gaussian-only model misses this failure mode.
- **Tracking makes errors colored.** Filtering reduces frame-to-frame jitter, but it introduces lag and lets a bias persist for several frames. Velocity is a derived, filtered estimate, so it should be noisy too.

Useful primary sources:

- Hung et al., [LET-3D-AP: Longitudinal Error Tolerant 3D Average Precision for Camera-Only 3D Detection](https://arxiv.org/abs/2206.07705)
- Geiger et al., [KITTI object detection and orientation benchmark](https://www.cvlibs.net/datasets/kitti/eval_object.php)
- Caesar et al., [nuScenes: A multimodal dataset for autonomous driving](https://arxiv.org/abs/1903.11027)
- Chen et al., [MonoRUn: Monocular 3D Object Detection by Reconstruction and Uncertainty Propagation](https://openaccess.thecvf.com/content/CVPR2021/html/Chen_MonoRUn_Monocular_3D_Object_Detection_by_Reconstruction_and_Uncertainty_Propagation_CVPR_2021_paper.html)

Benchmark numbers are not a universal sensor specification: they mix detector architecture, training data, camera calibration, weather, range, class, and matching thresholds. A production stack should fit residual distributions from its own recorded and labeled drives.

## Playground model

The `Noisy vehicle poses` setting applies a deterministic, seed-controlled approximation of a tracked camera-only 3D detector. Each detection now includes `relativeHeading` in radians. Positive yaw turns toward ego's right.

The one-standard-deviation core model at representative ranges is approximately:

| Range | Lateral position | Longitudinal position | Yaw | Length |
| ---: | ---: | ---: | ---: | ---: |
| 10 m | 0.06 m | 0.15 m | 1.4° | 0.08 m |
| 50 m | 0.19 m | 0.62 m | 3.6° | 0.15 m |
| 100 m | 0.44 m | 1.63 m | 7.5° | 0.24 m |

The model also includes distance-scaled velocity and width error, short-lived Gauss-Markov correlation, about 110 ms of output filtering, confidence degradation, rare 2.2–3.8× innovations, and distance/off-axis-dependent missed detections. This is intentionally less severe than Waymo's 10% evaluation tolerance: it represents a tracked, reasonably good-weather estimate while remaining useful for PID and adaptive-cruise experiments.

This model still omits false-positive tracks, explicit occluder geometry, rain/glare/domain shift, camera calibration drift, multi-modal yaw ambiguity, and shared ego-localization error. Those are the next additions if perception robustness becomes a core lesson.

## Should this project use a physics engine?

**Not for its current goal.** The playground teaches controller behavior on a top-down highway. It already has deterministic fixed-step longitudinal dynamics, steering/actuator lag, road-relative motion, oriented collision checks, and more than 100 traffic vehicles. A general rigid-body engine would add bundle/runtime cost and tuning complexity without automatically producing credible tire behavior. Rapier's own documentation notes that rigid bodies alone are not sufficient for cars; joints and a vehicle-specific model are still required.

The better next step is a small, explicit vehicle model:

1. Replace the current direct yaw-rate mapping with a kinematic single-track/bicycle equation using wheelbase and physical steering angle.
2. Add steering-angle/rate limits and separate throttle and brake curves.
3. Only if high-speed handling matters, add lateral velocity, yaw inertia, tire slip-angle forces, and a friction circle (a dynamic bicycle model).
4. Keep collision detection separate and deterministic. Consider a 2D collision library only when scenes gain barriers, debris, pushing, spinouts, or many non-rectangular bodies.

CommonRoad uses kinematic single-track and more detailed single-track/multi-body models as distinct fidelity levels. CARLA likewise delegates genuinely high-fidelity vehicle dynamics to specialized systems such as Chrono or CarSim. That is a useful boundary: use a vehicle-dynamics model for handling fidelity; use a generic physics engine when contact-rich rigid-body interaction becomes part of the product.

References:

- [CommonRoad vehicle models](https://commonroad.in.tum.de/)
- [Rapier rigid-body guide](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/)
- [CARLA Chrono integration](https://carla.readthedocs.io/en/latest/tuto_G_chrono/)
