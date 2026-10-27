"""Run the reproducible one-shot inspection demo; persistent hosting uses oi-vision-demo."""

from pathlib import Path

from oi_vision.demo import DemoEnvironment, finish_run, main

if __name__ == "__main__":
    main(default_root=Path(__file__).resolve().parents[3])
