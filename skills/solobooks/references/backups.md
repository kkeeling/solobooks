# Backups, synced folders and moving machines

The books are seven years of records on one machine. solobooks keeps dated copies on that machine; getting copies off it is your job and the person's, because solobooks never reaches outside the machine.

## Pick a backup folder

Ask the person where backups should go, ideally a folder that leaves the machine: an external drive, or a folder their cloud drive syncs (a synced folder is fine for backups, just not for the live books). Then:

```sh
solobooks backup set --folder ~/Dropbox/solobooks-backups
```

It writes today's backup at once, so a wrong folder shows up now. After that, the first time the books change each day, solobooks first writes a copy named for that day, such as `solobooks-2026-10-23.sqlite`, and keeps every one. Days with no change get no copy, since nothing changed. Before an upgrade to a newer solobooks changes the books file, it writes `solobooks-<date>-before-upgrade-from-v<N>.sqlite`; if it can't, it refuses and leaves the books as they were.

`solobooks doctor` warns when no backup folder is chosen, or when the folder has gone missing (an unplugged drive). A write whose backup couldn't be written still goes ahead, and its result carries a `warnings` line saying so. Tell the person.

To restore, stop using solobooks, copy the backup they choose over `solobooks.sqlite` in the books folder (keep the current file aside first), and run `solobooks doctor`.

## The synced-folder warning

A live SQLite file in iCloud Drive, Dropbox, OneDrive or Google Drive can be corrupted when the sync copies it mid-write. When the books folder sits in one, every write's result and `solobooks doctor` carry a warning. Don't ignore it: tell the person, and offer to move the books out with `solobooks move`.

## Moving the books

```sh
solobooks move --to ~/solobooks
```

The folder must be empty or new. solobooks copies the books file safely while holding other writers off, copies receipts, invoice PDFs and statements and checks each one, then points its settings at the new folder. The old folder is left as it was: once the person has checked a report from the new folder, they can delete it.

To move to another machine, run `solobooks move` into a folder you can carry (a drive, or a synced folder used only for the trip), copy that folder to the new machine, install solobooks there and run `solobooks setup --books <that folder>`, then `solobooks doctor`. Use the books on one machine at a time.
