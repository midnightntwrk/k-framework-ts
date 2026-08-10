%expect 0
%token ID "+"
%%
E: E "+" E | ID ;
