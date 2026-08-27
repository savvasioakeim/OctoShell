# CLA signatures

This branch stores `signatures/cla.json`, written by the CLA Assistant workflow
when a contributor signs the Contributor License Agreement.

It is deliberately kept OFF `main`: `main` is protected (changes must go through
a pull request), and the action commits directly, so writing signatures there
fails with "Changes must be made through a pull request". This branch must stay
unprotected for the workflow to work.

Nothing here is source code. Do not merge this branch into `main`.
