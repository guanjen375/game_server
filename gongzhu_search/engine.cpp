// The directory's Python wrapper supplies contiguous buffers to this batch simulator.
// Card i is suit * 13 + rank - 2, in the game's SHCD order.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>

namespace {
using Bits = std::uint64_t;
using Byte = std::uint8_t;
using Four = std::array<Bits, 4>;
constexpr Bits bit(int c) { return Bits{1} << c; }
constexpr Bits all = bit(52) - 1;
constexpr Bits suit(int s) { return (bit(13) - 1) << (13 * s); }
constexpr Bits hearts = suit(1), pig = bit(10), sheep = bit(48), trans = bit(34);
constexpr Bits points = hearts | pig | sheep | trans;
constexpr int heart_penalty[] = {2,3,10,5,6,7,8,9,10,20,30,40,50};
constexpr int fields = 1347, packed = 64;
int count(Bits b) { return __builtin_popcountll(b); }
int first(Bits b) { return __builtin_ctzll(b); }
int last(Bits b) { return 63 - __builtin_clzll(b); }
Byte level(int v, int max) { return std::lrint(255.0 * std::min(v, max) / max); }
int relative(int seat, int reference) { return (seat - reference + 4) & 3; }

struct Game {
    Four hands{}, played{}, taken{};
    Bits table = 0;
    int table_cards[4]{}, voids[4]{}, led[4]{};
    int step = 0, leader = 0, opener = 0;
    int turn() const { return step % 4; }
    int actor() const { return (leader + turn()) & 3; }
    int winning() const {
        int best = 0;
        for (int i = 1; i < turn(); ++i)
            if (table_cards[i] / 13 == table_cards[0] / 13 && table_cards[i] > table_cards[best]) best = i;
        return best;
    }
    Bits legal() const {
        Bits hand = hands[actor()];
        Bits follow = turn() ? hand & suit(table_cards[0] / 13) : 0;
        return follow ? follow : hand;
    }
    void play(int card) {
        int i = turn(), p = actor(), lead = i ? table_cards[0] / 13 : card / 13;
        hands[p] ^= bit(card);
        if (card / 13 != lead) voids[p] |= 1 << lead;
        table_cards[i] = card;
        table |= bit(card);
        if (i == 3) {
            int top = last(table & suit(lead));
            int winner = leader;
            for (int j = 0; j < 4; ++j) {
                int seat = (leader + j) & 3;
                played[seat] |= bit(table_cards[j]);
                if (table_cards[j] == top) winner = seat;
            }
            taken[winner] |= table & points;
            ++led[lead];
            leader = winner;
            table = 0;
        }
        ++step;
    }
};

int card_score(Bits pile, bool flipped) {
    Bits h = pile & hearts;
    bool p = pile & pig, s = pile & sheep, t = pile & trans;
    if (h == hearts && (t || (p && s))) return t && p && s ? 1000 : 500;
    if (pile == trans) return 50;
    int value = h == hearts ? 200 : 0;
    if (h != hearts) for (Bits b=h; b; b &= b-1) value -= heart_penalty[first(b)-13];
    value += (int(s)-int(p)) * (flipped ? -100 : 100);
    return t ? value*2 : value;
}
void scores(const Four& taken, std::int16_t* out) {
    bool flipped = false;
    for (auto t : taken) flipped |= (t & hearts) == hearts;
    for (int p=0; p<4; ++p) out[p] = 50 + card_score(taken[p], flipped);
}
int score_index(int card) {
    if (card >= 13 && card < 26) return card - 13;
    return card == 10 ? 13 : card == 48 ? 14 : 15;
}
void tag(Byte* row, Bits b, int v) {
    for (; b; b &= b-1) row[first(b)] = v;
}

void observation(const Game& g, Byte* x, Byte* mask) {
    int me=g.actor(), n=g.turn(), trick=g.step/4;
    Bits hand=g.hands[me], seen=hand | g.table;
    std::memset(x,0,fields);
    std::memset(mask,0,52);
    tag(mask,g.legal(),1);
    tag(x,hand,1);
    int heart_counts[4], sum_hearts=0, collector=-1;
    for (int p=0;p<4;++p) {
        int r=relative(p,me);
        seen |= g.played[p];
        tag(x+281+52*r,g.played[p],1);
        for (Bits b=g.taken[p];b;b &= b-1) x[489+r*16+score_index(first(b))]=1;
        if (r) for (int s=0;s<4;++s) x[553+(r-1)*4+s]=(g.voids[p]>>s)&1;
        heart_counts[p]=count(g.taken[p]&hearts);
        sum_hearts+=heart_counts[p];
        x[592+r]=128; // independent deals start with equal cumulative totals
        x[599+r]=level(heart_counts[p],13);
        for(int k=0;k<3;++k) x[607+r*3+k]=bool(g.taken[p] & std::array<Bits,3>{pig,sheep,trans}[k]);
    }
    for (int p=0;p<4;++p) if (sum_hearts && heart_counts[p]==sum_hearts) {
        collector=p; x[603+relative(p,me)]=1;
    }
    Bits unseen=all ^ seen;
    tag(x+52,unseen,1);
    for (int i=0;i<n;++i) x[104+(relative((g.leader+i)&3,me)-1)*52+g.table_cards[i]]=1;
    int top=-1, top_seat=-1, lead=n?g.table_cards[0]/13:4;
    x[260+lead]=1;
    if (n) {
        int best=g.winning();
        top=g.table_cards[best]; top_seat=(g.leader+best)&3;
        x[265+relative(top_seat,me)-1]=1; x[268+top%13]=1;
    }
    x[565+trick]=1;
    for (int k=0;k<3;++k) {
        Bits b=std::array<Bits,3>{pig,sheep,trans}[k];
        x[578+k]=bool(g.table & b); x[582+k]=bool(unseen & b);
    }
    x[581]=bool(g.table & hearts); x[585]=n==3;
    x[590]=level(count(g.table & hearts),3); x[591]=level(count(unseen & hearts),13);
    for(int s=0;s<4;++s) {
        Bits mine=hand & suit(s), outside=unseen & suit(s);
        x[586+s]=level(count(outside),13);
        int void_count=0;
        for(int p=0;p<4;++p) if(p!=me && (g.voids[p] & (1<<s))) ++void_count;
        for(Bits b=mine;b;b&=b-1) {
            int c=first(b);
            Bits below=bit(c)-1;
            int lower=count(outside & below), higher=count(outside & ~below);
            Byte* act=x+619+c;
            if(n) act[52*(s!=lead?2:c>top?0:1)]=1;
            act[52*3]=c==first(mine); act[52*4]=c==last(mine);
            act[52*5]=higher==0; act[52*6]=lower==0;
            act[52*7]=level(higher,12); act[52*8]=level(lower,12);
            act[52*9]=level(count(mine),13); act[52*10]=level(void_count,3);
            act[52*11]=level(g.led[s],4);
            if(collector>=0 && ((g.table & hearts)||s==1) && (n||!higher)) {
                int win=(!n || (s==lead && c>top))?me:top_seat;
                act[52*(win==collector?12:13)]=1;
            }
        }
    }
}

// The leaf value always uses coordinates relative to the next actor. The 52
// card locations partition the deck, including current trick and captured points.
void pack(const Game& g, Byte* z, std::int16_t* bank) {
    int ref=g.actor(), n=g.turn();
    for(int p=0;p<4;++p) {
        int r=relative(p,ref);
        tag(z,g.hands[p],r);
        tag(z,g.taken[p],8+r);
        tag(z,g.played[p] & ~points,12+r);
        z[52+r]=g.voids[p];
    }
    for(int i=0;i<n;++i) z[g.table_cards[i]]=4+relative((g.leader+i)&3,ref);
    z[56]=n; z[57]=n?g.table_cards[0]/13:4; z[58]=n?g.table_cards[g.winning()]%13:13;
    z[59]=n?relative((g.leader+g.winning())&3,ref):4;
    for(int s=0;s<4;++s) z[60+s]=g.led[s];
    std::int16_t sc[4]; scores(g.taken,sc);
    for(int p=0;p<4;++p) bank[relative(p,ref)]=sc[p]-50;
}
}

extern "C" {
int gz_size() { return sizeof(Game); }
void gz_init(int n, const Byte* decks, Game* games) {
    #pragma omp parallel for if(n>=256) schedule(static)
    for(int i=0;i<n;++i) {
        Game g{};
        for(int j=0;j<52;++j) {
            int c=decks[i*52+j], p=j/13;
            g.hands[p] |= bit(c);
            if(c==5) g.opener=g.leader=p;
        }
        games[i]=g;
    }
}
void gz_obs(int n,const Game* games,Byte* x,Byte* masks,Byte* seats,Byte* openers) {
    #pragma omp parallel for if(n>=256) schedule(static)
    for(int i=0;i<n;++i) {
        observation(games[i],x+i*fields,masks+i*52);
        seats[i]=games[i].actor(); openers[i]=relative(games[i].opener,seats[i]);
    }
}
int gz_play(int n,Game* games,const Byte* cards) {
    int errors=0;
    #pragma omp parallel for if(n>=256) schedule(static) reduction(+:errors)
    for(int i=0;i<n;++i) {
        int card=cards[i];
        if(card>=52 || !(games[i].legal() & bit(card))) ++errors;
        else games[i].play(card);
    }
    return errors;
}
void gz_pack(int n,const Game* games,Byte* z,std::int16_t* bank,Byte* refs) {
    #pragma omp parallel for if(n>=256) schedule(static)
    for(int i=0;i<n;++i) {
        pack(games[i],z+packed*i,bank+4*i); refs[i]=games[i].actor();
    }
}
void gz_scores(int n,const Game* games,std::int16_t* result,Byte* owners) {
    for(int i=0;i<n;++i) {
        scores(games[i].taken,result+4*i);
        for(int p=0;p<4;++p) for(Bits b=games[i].taken[p];b;b&=b-1)
            owners[16*i+score_index(first(b))]=p;
    }
}
void gz_score_piles(int n,const Four* piles,std::int16_t* out) {
    for(int i=0;i<n;++i) scores(piles[i],out+4*i);
}
}

namespace {
struct Random {
    Bits state;
    Bits next() {
        Bits x=(state+=0x9e3779b97f4a7c15ULL);
        x=(x^(x>>30))*0xbf58476d1ce4e5b9ULL;
        x=(x^(x>>27))*0x94d049bb133111ebULL;
        return x^(x>>31);
    }
    double unit() { return (next()>>11)*0x1.0p-53; }
};

Bits read_tags(const Byte* x, int n) {
    Bits mask=0;
    for(int i=0;i<n;++i) if(x[i]) mask|=bit(i);
    return mask;
}

// Recover only facts the current seat can see. Other hands remain empty here.
Game public_state(const Byte* x, int opener) {
    Game g{};
    g.opener=opener;
    g.hands[0]=read_tags(x,52);
    int n=0, trick=first(read_tags(x+565,13));
    for(int p=1;p<4;++p) {
        Bits b=read_tags(x+104+(p-1)*52,52);
        if(b) { g.table_cards[n++]=first(b); g.table|=b; }
        g.voids[p]=int(read_tags(x+553+(p-1)*4,4));
    }
    g.step=4*trick+n;
    g.leader=(4-n)&3;
    for(int p=0;p<4;++p) {
        g.played[p]=read_tags(x+281+p*52,52);
        const Byte* pile=x+489+p*16;
        g.taken[p]=read_tags(pile,13)<<13;
        if(pile[13]) g.taken[p]|=pig;
        if(pile[14]) g.taken[p]|=sheep;
        if(pile[15]) g.taken[p]|=trans;
    }
    for(int s=0;s<4;++s) {
        Bits mine=g.hands[0]&suit(s);
        if(mine) g.led[s]=std::lrint(x[1191+first(mine)]*4.0/255);
        // The value model uses these as secondary context only. Public card
        // counts are available even when per-action lead counts are absent.
        else {
            Bits gone=0;
            for(auto played:g.played) gone|=played;
            g.led[s]=count(gone & suit(s))/4;
        }
    }
    return g;
}

struct Sampler {
    int cards[39]{}, allowed[39]{}, room[3]{}, total=0, reserved=-1;
    bool unrestricted=true;
    double ways[14][14][14], chance[39][3];
    Sampler(const Game& g, Bits unseen, const float* weights) {
        if(unseen & bit(5)) {
            reserved=g.opener;
            unseen ^= bit(5);
        }
        for(int j=0;j<3;++j) {
            int p=j+1;
            room[j]=13-g.step/4-(g.turn() && p>=4-g.turn())-(p==reserved);
        }
        for(Bits b=unseen;b;b&=b-1) {
            int c=first(b), mask=0;
            for(int j=0;j<3;++j) if(!(g.voids[j+1] & (1<<(c/13)))) mask|=1<<j;
            for(int j=0;j<3;++j) chance[total][j]=weights ? weights[3*c+j] : 1.0;
            cards[total]=c; allowed[total++]=mask;
            if(mask!=7 || weights) unrestricted=false;
        }
        if(room[0]<0 || room[1]<0 || room[2]<0 || room[0]+room[1]+room[2]!=total)
            throw std::runtime_error("inconsistent public hand sizes");
        if(!unrestricted) {
            for(int a=0;a<=room[0];++a) for(int b=0;b<=room[1];++b) for(int c=0;c<=room[2];++c) {
                int i=total-a-b-c;
                if(i==total) { ways[a][b][c]=1; continue; }
                int mask=allowed[i];
                ways[a][b][c]=(a && (mask&1)?chance[i][0]*ways[a-1][b][c]:0)
                             +(b && (mask&2)?chance[i][1]*ways[a][b-1][c]:0)
                             +(c && (mask&4)?chance[i][2]*ways[a][b][c-1]:0);
            }
            if(ways[room[0]][room[1]][room[2]]==0) throw std::runtime_error("inconsistent public voids");
        }
    }
    void draw(Game& g, Random& rng) const {
        if(reserved>=0) g.hands[reserved]|=bit(5);
        if(unrestricted) {
            int order[39];
            std::copy_n(cards,total,order);
            for(int i=total-1;i>0;--i) std::swap(order[i],order[rng.next()%(i+1)]);
            int i=0;
            for(int p=0;p<3;++p) for(int j=0;j<room[p];++j) g.hands[p+1]|=bit(order[i++]);
            return;
        }
        int a=room[0],b=room[1],c=room[2];
        for(int i=0;i<total;++i) {
            int m=allowed[i];
            double wa=a&&(m&1)?chance[i][0]*ways[a-1][b][c]:0, wb=b&&(m&2)?chance[i][1]*ways[a][b-1][c]:0;
            double r=rng.unit()*ways[a][b][c];
            if(r<wa) { g.hands[1]|=bit(cards[i]); --a; }
            else if(r<wa+wb) { g.hands[2]|=bit(cards[i]); --b; }
            else { g.hands[3]|=bit(cards[i]); --c; }
        }
    }
};

using Outcome = std::array<int,4>;
Outcome utility(const Game& g) {
    std::int16_t sc[4]; scores(g.taken,sc);
    int sum=sc[0]+sc[1]+sc[2]+sc[3];
    Outcome v{};
    for(int p=0;p<4;++p) v[p]=4*sc[p]-sum;  // divide by three for point margins
    return v;
}
// Each seat maximizes its own final margin. Search both remaining tricks
// exactly inside each sampled deal, without pooling the three opponents.
Outcome endgame(Game g) {
    if(g.step==52) return utility(g);
    int actor=g.actor();
    Outcome best{}; best[actor]=-100000;
    for(Bits b=g.legal();b;b&=b-1) {
        Game child=g; child.play(first(b));
        Outcome v=endgame(child);
        if(v[actor]>best[actor]) best=v;
    }
    return best;
}

int rollout_card(const Game& g) {
    Bits legal=g.legal();
    if(!(legal & (legal-1))) return first(legal);
    int me=g.actor(),n=g.turn(),lead=n?g.table_cards[0]/13:-1;
    int top=n?g.table_cards[g.winning()]:-1;
    Bits gone=g.table;
    for(Bits b:g.played) gone|=b;
    Bits hand=g.hands[me], unseen=all & ~(gone|hand);
    int collector=-1;
    bool split=false;
    for(int p=0;p<4;++p) if(g.taken[p]&hearts) {
        if(collector>=0) split=true;
        collector=p;
    }
    int red=collector>=0?count(g.taken[collector]&hearts):0;
    bool pursue=!split && collector==me && (red>=9 || (red>=4 && count(hand & hearts & (bit(26)-bit(22)))>=2));
    bool guard=!split && collector>=0 && collector!=me && red>=6;
    bool flip=!split && red==13;
    float best=-1e9f; int pick=first(legal);
    for(Bits b=legal;b;b&=b-1) {
        int c=first(b),s=c/13,r=c%13;
        Bits mine=hand&suit(s), outside=unseen&suit(s), below=bit(c)-1;
        bool leading=!n, off=n && s!=lead;
        bool winning=leading || (!off && c>top);
        int later=3-n;
        float high=float(count(outside&below)+1)/(count(outside)+2);
        float holds=winning?(later && (outside&~below)?std::pow(high,0.75f*later):1.f):0.f;
        float table_points=0;
        Bits pile=g.table|bit(c);
        for(Bits h=pile&hearts;h;h&=h-1) table_points-=heart_penalty[first(h)-13];
        table_points+=(int(bool(pile&sheep))-int(bool(pile&pig)))*(flip?-100:100);
        if(pursue && (pile&hearts)) table_points+=65;
        if(guard && (pile&hearts) && (leading || ((g.leader+g.winning())&3)==collector))
            table_points+=30;
        if(later) {
            table_points-=leading?12:5;
            if(s==0 && c>10 && (unseen&pig)) table_points-=46;
            if(s==3 && c>48 && (unseen&sheep)) table_points+=18;
        }
        if(pile&trans) table_points=1.5f*table_points+(count(g.taken[me]&hearts)?-12:3);
        float val=holds*table_points;
        val+=(r-5)*0.95f + (count(mine)==1 ? 4.5f : 0);
        if(c==10) val+=flip?-27:37;
        if(c==48) val+=flip?27:-40;
        if(c==34) val+=count(g.taken[me]&hearts)?9:3;
        if(s==1) val+=pursue?-r*1.5f:heart_penalty[r]*0.37f;
        if(s==0 && c>10 && (unseen&pig)) val+=12;
        if(s==3 && c>48 && (unseen&sheep)) val-=15;
        if(pursue && winning) val+=18*holds;
        if(val>best) { best=val; pick=c; }
    }
    return pick;
}

void leaves(const Byte* x,int opener,const float* weights,int worlds,int horizon,bool full_rollout,int exact_cards,
            Byte* z,std::int16_t* bank,Byte* roots,float* rollout,Byte* exact) {
    Game base=public_state(x,opener);
    Bits unseen=read_tags(x+52,52), legal=base.legal();
    Sampler sampler(base,unseen,weights);
    Bits seed=1469598103934665603ULL;
    for(int j=0;j<fields;++j) seed=(seed^x[j])*1099511628211ULL;
    Random rng{seed^Bits(opener)};
    int i=0;
    for(int draw=0;draw<worlds;++draw) {
        Game world=base; sampler.draw(world,rng);
        for(Bits b=legal;b;b&=b-1,++i) {
            Game child=world; child.play(first(b));
            int stop=horizon==0 ? world.step+4-world.turn() : world.step+horizon;
            while(child.step<std::min(stop,52)) child.play(rollout_card(child));
            pack(child,z+i*packed,bank+i*4);
            roots[i]=relative(0,child.actor());
            // The exact endgame starts directly after the chosen root move.
            exact[i]=(52-world.step<=exact_cards || child.step==52);
            if(52-world.step<=exact_cards) {
                Game next=world; next.play(first(b));
                rollout[i]=endgame(next)[0]/3.0f;
            } else if(full_rollout || child.step==52) {
                while(child.step<52) child.play(rollout_card(child));
                rollout[i]=utility(child)[0]/3.0f;
            } else rollout[i]=0;
        }
    }
}
}

extern "C" int gz_leaves(int n,const Byte* x,const Byte* openers,const int* offsets,const float* weights,int worlds,
                         int horizon,int full_rollout,int exact_cards,Byte* z,std::int16_t* bank,
                         Byte* roots,float* rollout,Byte* exact) {
    int errors=0;
    #pragma omp parallel for if(n>=16) schedule(dynamic,4) reduction(+:errors)
    for(int i=0;i<n;++i) {
        int off=offsets[i];
        try {
            if(count(public_state(x+i*fields,openers[i]).legal())*worlds != offsets[i+1]-off)
                throw std::runtime_error("legal mask mismatch");
            leaves(x+i*fields,openers[i],weights ? weights+156*i : nullptr,worlds,horizon,full_rollout,exact_cards,
                   z+off*packed,bank+off*4,roots+off,rollout+off,exact+off);
        } catch(const std::exception&) { ++errors; }
    }
    return errors;
}

extern "C" int gz_forks(int n,const Byte* x,const Byte* openers,const int* offset,const float* weights,int worlds,Game* forks) {
    int errors=0;
    #pragma omp parallel for if(n>=16) schedule(dynamic,4) reduction(+:errors)
    for(int i=0;i<n;++i) {
        try {
            const Byte* row=x+i*fields;
            Game base=public_state(row,openers[i]);
            Bits legal=base.legal();
            if(count(legal)*worlds!=offset[i+1]-offset[i]) throw std::runtime_error("legal mask mismatch");
            Sampler sampler(base,read_tags(row+52,52),weights ? weights+156*i : nullptr);
            Bits seed=1469598103934665603ULL;
            for(int j=0;j<fields;++j) seed=(seed^row[j])*1099511628211ULL;
            Random rng{seed^Bits(openers[i])};
            int idx=offset[i];
            for(int j=0;j<worlds;++j) {
                Game world=base; sampler.draw(world,rng);
                for(Bits b=legal;b;b&=b-1) {
                    forks[idx]=world;
                    forks[idx++].play(first(b));
                }
            }
        } catch(const std::exception&) { ++errors; }
    }
    return errors;
}
extern "C" void gz_finish(int n,const Game* states,int exact_cards,float* margin) {
    #pragma omp parallel for if(n>=64) schedule(dynamic,16)
    for(int i=0;i<n;++i) {
        Game g=states[i];
        while(g.step<52-exact_cards) g.play(rollout_card(g));
        margin[i]=endgame(g)[0]/3.0f;
    }
}

extern "C" void gz_gelu(int n,float* x) {
    for(int i=0;i<n;++i) x[i]=0.5f*x[i]*(1.0f+std::erf(0.7071067811865476f*x[i]));
}
