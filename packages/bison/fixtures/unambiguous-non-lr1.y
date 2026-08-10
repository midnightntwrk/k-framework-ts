%define lr.type ielr
%token A "a" C "c" D "d" E "e"
%start start
%%
start: A left D D | A right D E ;
left: C ;
right: C ;
%%
