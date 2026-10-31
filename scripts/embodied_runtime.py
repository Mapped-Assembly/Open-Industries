"""Run the local SO-101 workbench using the repository's Python controller."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/embodied'))
from oi_embodied.server import main

if __name__ == '__main__':
    main()
