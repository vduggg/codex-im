#!/usr/bin/env python3
import curses
import os
import subprocess
import sys

GATEWAY = "/Users/keeploving/.local/bin/codex-gateway"
OPTIONS = [
    ("Status", "status"),
    ("Restart", "restart"),
    ("Stop", "stop"),
    ("Start", "start"),
    ("Logs", "logs"),
    ("Quit", "quit"),
]


def draw_menu(stdscr, selected):
    stdscr.erase()
    height, width = stdscr.getmaxyx()

    title = "Codex-Feishu Gateway"
    help_text = "Use Up/Down to choose, Enter to run, q to quit."
    tip = "This panel controls only the Feishu Gateway, not Codex Desktop."

    stdscr.addstr(1, 2, title, curses.A_BOLD)
    stdscr.addstr(3, 2, help_text)

    for idx, (label, _action) in enumerate(OPTIONS):
        y = 5 + idx
        prefix = "  "
        text = f"{prefix}{label}"
        if idx == selected:
            stdscr.addstr(y, 2, f"> {label}", curses.A_REVERSE | curses.A_BOLD)
        else:
            stdscr.addstr(y, 2, text)

    if height > 14:
        stdscr.addstr(13, 2, "Tip: ", curses.A_BOLD)
        stdscr.addstr(13, 7, tip[: max(0, width - 9)])

    stdscr.refresh()


def run_action(action):
    curses.def_prog_mode()
    curses.endwin()
    os.system("printf '\\033[H\\033[2J'")

    if action == "quit":
        raise SystemExit(0)

    print(f"Running: codex-gateway {action}\n")
    result = subprocess.run([GATEWAY, action], text=True)
    print()
    input("Press Enter to return to menu...")

    curses.reset_prog_mode()
    return result.returncode


def main(stdscr):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    stdscr.keypad(True)
    selected = 0

    while True:
        draw_menu(stdscr, selected)
        key = stdscr.getch()

        if key in (curses.KEY_UP, ord("k")):
            selected = (selected - 1) % len(OPTIONS)
        elif key in (curses.KEY_DOWN, ord("j")):
            selected = (selected + 1) % len(OPTIONS)
        elif key in (curses.KEY_ENTER, 10, 13):
            run_action(OPTIONS[selected][1])
        elif key in (ord("q"), ord("Q")):
            break


if __name__ == "__main__":
    curses.wrapper(main)
