# Workout Tracker

A personal app for recording strength-training workouts and daily protein intake, and for tracking progress on each exercise over time.

## Language

### Training

**Workout**:
One training session on a given date, made up of the exercises performed in it.
_Avoid_: Session, day, log

**Live Workout**:
A Workout logged while it happens, so its start and end times are known.
_Avoid_: Active session

**Back-dated Workout**:
A Workout entered after the fact, including imported history, which has a date but no start or end time.

**Workout Label**:
The free-text name a lifter gives a workout to describe its focus, such as "Chest + Triceps" or "Leg Day".
_Avoid_: Split, routine, category

**Exercise**:
A distinct movement in the lifter's catalog, identified by one canonical name and an Exercise Type.
_Avoid_: Movement, lift (when meaning the catalog entry)

**Exercise Alias**:
An alternate name that refers to an existing Exercise, such as "Incline press" for "Incline Dumbbell Press".
_Avoid_: Synonym, nickname

**Exercise Type**:
The equipment category of an Exercise (barbell, dumbbell, machine/cable, bodyweight, or duration). It determines how a Set is entered and read.
_Avoid_: Equipment, kind

**Set**:
One continuous effort within an Exercise in a Workout, recorded as weight × reps, reps alone, or a duration.
_Avoid_: Rep (a rep is one repetition within a Set)

**Load**:
The weight recorded for a Set. For barbell exercises it is the total including the bar; for dumbbell exercises it is the weight of one dumbbell.
_Avoid_: Plates (plates are only the input; Load is what's stored)

**Bar Weight**:
The empty-bar weight remembered for each barbell Exercise (45 lb by default) and added to the entered plates to get the Load.

**Incomplete Set**:
A Set whose reps were never recorded (usually from imported notes). It appears in history but is excluded from Volume and Personal Records.

**Assisted Set**:
A Set performed with help, such as a spotter or support, so it never counts toward a Personal Record.

**Volume**:
Load × reps summed over the Sets of one Exercise in one Workout, counting each dumbbell once.

**Estimated 1RM**:
The heaviest single repetition a Set implies, calculated with the Epley formula.
_Avoid_: Max, 1RM (when not actually tested)

**Repeat Last Workout**:
Starting a new Workout pre-filled with the exercises from the most recent Workout that has the same Workout Label.
_Avoid_: Template, routine

**Last-Time Hint**:
The Sets recorded for an Exercise the last time it was performed, shown while logging it again.
_Avoid_: History, previous

**Personal Record (PR)**:
A Set that beats every earlier non-assisted, complete Set of the same Exercise: on heaviest Load or Estimated 1RM for weighted Exercises, or on reps for bodyweight Exercises.
_Avoid_: Best, max

**Rest Timer**:
A countdown that starts after a Set is logged and signals when the rest period has ended.

### Nutrition

**Protein Entry**:
A single amount of protein, in grams, eaten on a given day, with an optional source such as "Yogurt".
_Avoid_: Meal, food log

**Protein Source**:
A saved food with a default protein amount, such as "Protein shake – 25 g", used to add a Protein Entry in one tap.
_Avoid_: Food, item

**Protein Goal**:
The daily protein target, in grams, that Protein Entries are measured against.

### Recovery

**Complete Backup**:
A portable copy of the lifter's recorded data and preferences at one point in time, used to replace local data during recovery.

**Safety Backup**:
A Complete Backup of current data retained before a restore replaces it.

**Historical Import**:
Adding a reviewed collection of past notes without replacing current data or overwriting later edits when the same collection is submitted again.

### Planning and guidance

**Workout Plan**:
An ordered proposal of Exercises and Planned Sets that the lifter can review and apply to a Workout. It records intended training, not completed efforts.

**Planned Set**:
A target effort with intended reps, Load or duration. It does not become a Set until the lifter records what was actually performed.

**Effort Report**:
The lifter's description of how difficult a completed Set felt, optionally expressed as estimated reps remaining. Missing effort is unknown.

**Progression Suggestion**:
A proposed change to a future training target based on comparable recorded performance, which the lifter can accept, defer or dismiss.

**Nutrition Entry**:
A recorded food or intake amount with its known calories and macronutrients. Unknown nutrient amounts are distinct from zero; food estimates remain identified as estimates.
