# Test-only watch command. Writes its group id to ./pgid and one line to stderr, then
# for i = 1, 2, ...: waits for ./m$i and prints it in one write, or for ./e$i and exits
# with the code it holds. The test writes each file whole (temp file, then rename).
echo $$ > pgid
echo "to stderr" >&2
i=1
while :; do
  until [ -e m$i ] || [ -e e$i ]; do sleep 0.02; done
  [ -e e$i ] && exit "$(cat e$i)"
  cat m$i
  i=$((i+1))
done
