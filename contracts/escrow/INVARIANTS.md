# Escrow Contract State Machine Invariants

## State Machine Diagram

```mermaid
stateDiagram-v2
    [*] --> Pending: create_escrow()
    Pending --> Funded: fund_escrow()
    Funded --> Released: release_escrow() [beneficiary only]
    Funded --> Refunded: refund_escrow() [sender only & after timeout]
    Funded --> Disputed: dispute_escrow() [any party]
    Disputed --> Resolved: resolve_dispute() [arbitrator]
    Released --> [*]
    Refunded --> [*]
    Resolved --> [*]

    note right of Pending
        Escrow created
        Waiting for funding
    end note

    note right of Funded
        Escrow funded
        Active state
    end note

    note right of Released
        Funds released to beneficiary
        Terminal state
    end note

    note right of Refunded
        Funds returned to sender
        Terminal state
    end note
Valid State Transitions
From	To	Trigger	Conditions
Pending	Funded	fund_escrow()	Sender deposits amount
Funded	Released	release_escrow()	Beneficiary only
Funded	Refunded	refund_escrow()	Sender only, after timelock
Funded	Disputed	dispute_escrow()	Any party
Disputed	Resolved	resolve_dispute()	Arbitrator only
Any terminal	-	-	No transitions allowed
Invalid State Transitions (Must Reject)
Transition	Reason
Pending → Released	Not funded yet
Pending → Refunded	Not funded yet
Pending → Disputed	Not funded yet
Funded → Funded	Already funded
Released → any	Terminal state
Refunded → any	Terminal state
Disputed → Released	Must be resolved first
Disputed → Refunded	Must be resolved first
Invariants
Balance Invariant
Total balance = escrow amount + fees (no balance created or destroyed)

Balance before transition = balance after transition

State Invariant
Only defined transitions are allowed

Terminal states (Released, Refunded, Resolved) cannot transition

Access Control Invariant
Only beneficiary can call release_escrow()

Only sender can call refund_escrow() (and only after timelock)

Only arbitrator can call resolve_dispute()

Timelock Invariant
refund_escrow() can only be called after timelock has expired

release_escrow() can be called any time after funding

Re-entrancy Invariant
No state changes allowed during external calls

All balance transfers happen after state update

Property Test Coverage
Property 1: Valid State Transitions
All valid transitions succeed

State updates correctly

Property 2: Invalid State Transitions
All invalid transitions fail

Error messages are clear

Property 3: Balance Conservation
Balance is conserved across all transitions

No funds created or destroyed

Property 4: Access Control
Only authorized parties can perform actions

Unauthorized calls fail

Property 5: Re-entrancy
No re-entrant calls succeed

State consistency maintained

Property 6: Timelock
Refund only works after timelock

Release works any time
