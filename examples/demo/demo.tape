# Record the demo as a GIF with https://github.com/charmbracelet/vhs
#   cd examples/demo && vhs demo.tape
Output ../../docs/demo.gif
Set FontSize 16
Set Width 1200
Set Height 900
Set Theme "Catppuccin Mocha"
Hide
Type "docker compose build -q && clear"
Enter
Sleep 60s
Show
Type "docker compose up --abort-on-container-exit"
Enter
Sleep 12s
