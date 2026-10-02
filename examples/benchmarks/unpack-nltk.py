"""Install only the English text models and license from the official NLTK zip."""
from pathlib import Path
import sys
import zipfile

archive, destination = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
names = ["punkt_tab/README"] + [
    "punkt_tab/english/" + name for name in
    ("abbrev_types.txt", "collocations.tab", "ortho_context.tab", "sent_starters.txt")
]
with zipfile.ZipFile(archive) as source:
    for name in names:
        target = destination / "tokenizers" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        data = source.read(name)
        if target.exists() and target.read_bytes() != data:
            raise RuntimeError(f"Refusing to replace different NLTK model: {target}")
        target.write_bytes(data)
