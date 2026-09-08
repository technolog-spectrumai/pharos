"""Shared building blocks for every app builder in this repo.

Enigma's builder came first (`tools/enigma_builder`, ~8,400 lines) and most of
it is genuinely enigma's: feature editions, code signing, the privacy-HP price
table, Android. But five of its modules never mentioned enigma at all, and
those are the ones that carry the hard-won knowledge:

* running a build off the GUI thread so cargo can be CANCELLED — a plain
  terminate() leaves a multi-gigabyte build running unattended;
* a clean environment for launching the result, because a builder started from
  a snap poisons `LD_LIBRARY_PATH` and the app dies at exec;
* which Linux package format the host can actually produce, and saying so
  rather than implying an .rpm built on Ubuntu will run on Fedora.

Duplicating that three times for sketch, lazurite and primula would mean three
copies of each fix. So it lives here, imported by all four builders.

**What is NOT here**: anything that knows what an app IS. The zinnia apps have
no editions, no feature matrix and no signing story, and inventing one for them
to fit enigma's shape would be worse than the duplication. Each builder brings
its own idea of what it is building; this package only knows how to run it.
"""
