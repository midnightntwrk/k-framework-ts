%glr-parser
%token A
%%
S: X | Y ;
X: A %dprec 1 ;
Y: A %dprec 2 ;
