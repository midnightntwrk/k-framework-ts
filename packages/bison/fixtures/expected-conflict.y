%define lr.type ielr
%expect 1
%token ID PLUS "+"
%start expr
%%
expr: ID | expr PLUS expr ;
%%
