from sqlalchemy.orm import Session

from ..models import Analysis, EntityIdSequence


def next_analysis_id(db: Session) -> int:
    sequence = db.get(EntityIdSequence, "analysis")
    highest = max((row[0] for row in db.query(Analysis.id).all()), default=0)
    if sequence is None:
        sequence = EntityIdSequence(entity="analysis", next_id=highest + 1)
        db.add(sequence)
        db.flush()
    elif sequence.next_id <= highest:
        sequence.next_id = highest + 1
    value = sequence.next_id
    sequence.next_id += 1
    return value
