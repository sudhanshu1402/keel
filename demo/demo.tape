# keel crash/resume demo recording.
#
# Install the recorder once (https://github.com/charmbracelet/vhs):
#   brew install vhs
# Then render the GIF from the repo root:
#   vhs demo/demo.tape
# Output: demo/demo.gif  (drop it at the top of the README)

Output demo/demo.gif

Set Theme "TokyoNight"
Set FontSize 18
Set Width 1100
Set Height 700
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "rm -rf keel-data && clear" Enter
Show

Sleep 600ms
Type "# Run 1: charge the card, then the process crashes"
Enter
Sleep 800ms
Type "npx tsx examples/order-workflow.ts"
Enter
Sleep 2500ms

Type "# Run 2: resume the same run - it ships WITHOUT charging again"
Enter
Sleep 800ms
Type "npx tsx examples/order-workflow.ts"
Enter
Sleep 3000ms

Type "# No second 'charging' line. That is durable execution."
Enter
Sleep 2500ms

Hide
Type "rm -rf keel-data" Enter
Show
