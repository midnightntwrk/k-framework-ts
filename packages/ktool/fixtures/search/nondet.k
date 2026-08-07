module NONDET
  imports BOOL
  syntax KItem ::= "zero" | "one" | "two" | "three" | "five" | "duplicate" | "pairs" | "a" | "b" | "c" | "d" | "e"
                 | "pair" "(" KItem "," KItem ")"
  rule one => a
  rule two => a
  rule two => b
  rule three => a
  rule three => b
  rule three => c
  rule five => a
  rule five => b
  rule five => c
  rule five => d
  rule five => e
  rule duplicate => a
  rule duplicate => a
  rule pairs => pair(a, b)
  rule pairs => pair(c, d)
endmodule
